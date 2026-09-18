import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mock, test } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { inspect } from "node:util";
import { parseConfig } from "../dist/config.js";
import { readManifestBytes, readPreparedCache, savePreparedCache } from "../dist/prepared-cache.js";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const serverSource = `
import { appendFileSync, readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
appendFileSync(process.env.PID_FILE, process.pid + "\\n");
const mode = () => readFileSync(process.env.MODE_FILE, "utf8");
if (mode() === "stderr") console.error(process.env.SECRET);
const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, request => {
  const cursor = request.params?.cursor;
  if (mode() === "discovery-error" || (mode() === "pagination-failure" && cursor)) throw new Error(process.env.SECRET);
  const paginated = mode().startsWith("pagination");
  const tools = JSON.parse(process.env.TOOL_NAMES).map(name => ({name: cursor ? name + "_next" : name, description: "Fixture tool", inputSchema: { type: "object" }}));
  return { tools, nextCursor: paginated && (!cursor || mode() === "pagination-repeat") ? "next" : undefined };
});
server.setRequestHandler(CallToolRequestSchema, () => {
  if (mode() === "tool-error") throw new Error(process.env.SECRET);
  return { content: [{ type: "text", text: "fixture-result" }] };
});
process.stdin.on("end", () => process.exit(0));
await server.connect(new StdioServerTransport());
`;

function fixture(layout = "compiled", names = ["github", "github-test"], toolPrefix = true) {
  // Local fixtures share only dependency resolution with the source checkout.
  const root = mkdtempSync(join(project, ".cache-test-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  cpSync(join(project, "openclaw.plugin.json"), join(root, "openclaw.plugin.json"));
  const entryDir = layout === "compiled" ? join(root, "dist") : root;
  mkdirSync(entryDir, { recursive: true });
  cpSync(join(project, "dist"), entryDir, { recursive: true });
  const script = join(root, "server.mjs");
  const pids = join(root, "pids");
  writeFileSync(script, serverSource);
  writeFileSync(pids, "");
  names.forEach((_, index) => writeFileSync(join(root, `mode-${index}`), ""));
  const config = { toolPrefix, servers: names.map((name, index) => ({
    name, command: process.execPath, args: [script], env: {
      PID_FILE: pids, MODE_FILE: join(root, `mode-${index}`),
      TOOL_NAMES: JSON.stringify([toolPrefix ? "read" : `read_${index}`]),
      SECRET: "fixture-private-credential",
    },
  })) };
  return {
    root, entryDir, config, manifest: join(root, "openclaw.plugin.json"),
    setMode: (index, mode) => writeFileSync(join(root, `mode-${index}`), mode),
    pids: () => readFileSync(pids, "utf8").trim().split("\n").filter(Boolean).map(Number),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

function assertStopped(f) {
  for (const pid of f.pids()) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

async function prepare(f, config = f.config) {
  const child = spawn(process.execPath, [join(f.entryDir, "prepare.js")], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", data => { stdout += data; });
  child.stderr.setEncoding("utf8").on("data", data => { stderr += data; });
  child.stdin.end(typeof config === "string" ? config : JSON.stringify(config));
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert(!stdout.includes("fixture-private-") && !stderr.includes("fixture-private-"), "Preparation leaked credentials");
  assertStopped(f);
  return { code, stdout, stderr };
}

async function load(f, suffix = "") {
  const { default: register } = await import(pathToFileURL(join(f.entryDir, "index.js")).href + suffix);
  const tools = [], services = [];
  register({ pluginConfig: f.config, registerTool: tool => tools.push(tool), registerService: service => services.push(service) });
  return { tools, service: services[0] };
}

for (const [layout, names, prefix] of [
  ["root", ["github", "github-test"], true],
  ["compiled", ["github", "github-test"], true],
  ["compiled", ["custom-repo", "different-prefix"], true],
  ["compiled", ["github", "github-test"], false],
]) {
  test(`${layout}, ${names.join("/")}, prefix=${prefix}: prepare, start, invoke, stop and reload`, async () => {
    const f = fixture(layout, names, prefix);
    let loaded;
    try {
      await assert.rejects(load(f), /not prepared/);
      const first = await prepare(f);
      assert.equal(first.code, 0, first.stderr);
      assert.deepEqual(JSON.parse(first.stdout), { prepared: true, changed: true, servers: 2, tools: 2 });
      const bytes = readManifestBytes(f.manifest);
      const manifest = JSON.parse(bytes);
      const expected = names.map((name, index) => prefix ? `${name}_read` : `read_${index}`);
      assert.deepEqual(manifest.contracts.tools, expected);
      assert(!bytes.toString().includes("fixture-private-"));
      assert(!readFileSync(join(f.root, manifest.mcpToolCache), "utf8").includes("fixture-private-"));
      const repeated = await prepare(f);
      assert.equal(repeated.code, 0, repeated.stderr);
      assert.equal(JSON.parse(repeated.stdout).changed, false);
      assert.deepEqual(readManifestBytes(f.manifest), bytes);

      loaded = await load(f, "?first");
      assert.deepEqual(loaded.tools.map(tool => tool.name), expected);
      // A separate agent can invoke before its service has started.
      assert.equal((await loaded.tools[1].execute("lazy", {})).content[0].text, "fixture-result");
      await loaded.service.start();
      for (const tool of loaded.tools) assert.equal((await tool.execute("started", {})).content[0].text, "fixture-result");
      await loaded.service.stop();
      assertStopped(f);
      await assert.rejects(loaded.tools[0].execute("stopped", {}), /service is stopped/);
      assert.deepEqual(readManifestBytes(f.manifest), bytes, "Runtime changed the prepared manifest");
      loaded = await load(f, "?reload");
      await loaded.service.start();
      assert.equal((await loaded.tools[0].execute("reloaded", {})).content[0].text, "fixture-result");
    } finally {
      if (loaded) await loaded.service.stop();
      assertStopped(f);
      f.remove();
    }
  });
}

test("failed discovery or startup keeps the complete prepared snapshot", async () => {
  const f = fixture();
  let loaded;
  try {
    assert.equal((await prepare(f)).code, 0);
    const before = readManifestBytes(f.manifest);
    const oldCache = readPreparedCache(parseConfig(f.config), f.manifest);
    f.setMode(1, "discovery-error");
    const failure = await prepare(f);
    assert.notEqual(failure.code, 0);
    assert.match(failure.stderr, /discovering/);
    assert.deepEqual(readManifestBytes(f.manifest), before);
    assert.deepEqual(readPreparedCache(parseConfig(f.config), f.manifest), oldCache);
    loaded = await load(f);
    await assert.rejects(loaded.service.start(), error => {
      assert(!inspect(error).includes("fixture-private-"), "Startup error exposed a credential");
      return true;
    });
    assertStopped(f);
    assert.deepEqual(readManifestBytes(f.manifest), before);
    f.setMode(1, "");
    loaded = await load(f, "?recovered");
    await loaded.service.start();
    assert.equal((await loaded.tools[1].execute("recovered", {})).content[0].text, "fixture-result");
  } finally {
    if (loaded) await loaded.service.stop();
    assertStopped(f);
    f.remove();
  }
});

test("tool discovery covers every page and preserves the snapshot on later-page failure", async () => {
  const f = fixture();
  try {
    f.setMode(0, "pagination");
    assert.equal((await prepare(f)).code, 0);
    const before = readManifestBytes(f.manifest);
    assert.deepEqual(JSON.parse(before).contracts.tools, ["github_read", "github_read_next", "github-test_read"]);
    for (const mode of ["pagination-failure", "pagination-repeat"]) {
      f.setMode(0, mode);
      assert.notEqual((await prepare(f)).code, 0);
      assert.deepEqual(readManifestBytes(f.manifest), before);
    }
  } finally { assertStopped(f); f.remove(); }
});

test("a real cache-path write failure preserves the last good snapshot and releases the lock", async () => {
  const f = fixture();
  try {
    assert.equal((await prepare(f)).code, 0);
    const before = readManifestBytes(f.manifest);
    const config = parseConfig(f.config);
    const previous = readPreparedCache(config, f.manifest);
    const next = structuredClone(previous);
    next.servers.github[0].description = "Updated description";
    const bytes = JSON.stringify(next, null, 2) + "\n";
    const hash = createHash("sha256").update(bytes).digest("hex");
    const obstruction = join(f.root, `.tool-cache-${hash}.json`);
    mkdirSync(obstruction);
    assert.throws(() => savePreparedCache(config, next, before, f.manifest), /owned regular file/);
    assert.deepEqual(readManifestBytes(f.manifest), before);
    assert.deepEqual(readPreparedCache(config, f.manifest), previous);
    assert(!existsSync(join(f.root, ".mcp-prepare.lock")));
    assert(!readdirSync(f.root).some(name => name.startsWith(".mcp-manifest-")));
    rmSync(obstruction, { recursive: true });
    assert.equal(savePreparedCache(config, next, before, f.manifest), true);
    assert.deepEqual(readPreparedCache(config, f.manifest), next);
  } finally { assertStopped(f); f.remove(); }
});

test("a preparation lock is never stolen and explains exclusive recovery", async () => {
  const f = fixture();
  try {
    assert.equal((await prepare(f)).code, 0);
    const before = readManifestBytes(f.manifest);
    const lock = join(f.root, ".mcp-prepare.lock");
    writeFileSync(lock, `${process.pid}\n`);
    const result = await prepare(f);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Stop the gateway/);
    assert.match(result.stderr, /no preparation process is running/);
    assert.equal(readFileSync(lock, "utf8"), `${process.pid}\n`);
    assert.deepEqual(readManifestBytes(f.manifest), before);
  } finally { assertStopped(f); f.remove(); }
});

test("killing a cache writer preserves the selected snapshot and permits exclusive recovery", async () => {
  const f = fixture();
  try {
    assert.equal((await prepare(f)).code, 0);
    const before = readManifestBytes(f.manifest);
    const config = parseConfig(f.config);
    const previous = readPreparedCache(config, f.manifest);
    const next = structuredClone(previous);
    next.servers.github[0].description = "Interrupted cache update";
    const hash = createHash("sha256").update(JSON.stringify(next, null, 2) + "\n").digest("hex");
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const write = fs.writeFileSync;
      fs.writeFileSync = (file, bytes, ...options) => {
        if (Buffer.isBuffer(bytes) && bytes.includes('Interrupted cache update')) {
          write(file, bytes.subarray(0, 16), ...options);
          process.kill(process.pid, 'SIGKILL');
        }
        return write(file, bytes, ...options);
      };
      syncBuiltinESMExports();
      const {savePreparedCache} = await import(${JSON.stringify(pathToFileURL(join(f.entryDir, "prepared-cache.js")).href)});
      const {parseConfig} = await import(${JSON.stringify(pathToFileURL(join(f.entryDir, "config.js")).href)});
      const {config, cache, before, manifest} = JSON.parse(fs.readFileSync(0, 'utf8'));
      savePreparedCache(parseConfig(config), cache, Buffer.from(before, 'base64'), manifest);
    `], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", data => { stderr += data; });
    child.stdin.end(JSON.stringify({config, cache: next, before: before.toString("base64"), manifest: f.manifest}));
    const signal = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (_code, signal) => resolve(signal));
    });
    assert.equal(signal, "SIGKILL", stderr);
    assert.deepEqual(readManifestBytes(f.manifest), before);
    assert.deepEqual(readPreparedCache(config, f.manifest), previous);
    assert(!existsSync(join(f.root, `.tool-cache-${hash}.json`)), "A partial cache was published");
    // The fixture owns this directory exclusively and the writer is dead.
    rmSync(join(f.root, ".mcp-prepare.lock"));
    assert.equal(savePreparedCache(config, next, before, f.manifest), true);
    assert.deepEqual(readPreparedCache(config, f.manifest), next);
  } finally { assertStopped(f); f.remove(); }
});

test("a failed manifest commit preserves the selected snapshot and removes the new cache", async () => {
  const f = fixture();
  try {
    assert.equal((await prepare(f)).code, 0);
    const before = readManifestBytes(f.manifest);
    const config = parseConfig(f.config);
    const previous = readPreparedCache(config, f.manifest);
    const files = readdirSync(f.root).sort();
    const next = structuredClone(previous);
    next.servers.github[0].description = "Updated description";
    const originalRename = fs.renameSync;
    const rename = mock.method(fs, "renameSync", (source, target) => {
      if (target === f.manifest) throw Object.assign(new Error("Injected commit failure"), { code: "EACCES" });
      return originalRename(source, target);
    });
    syncBuiltinESMExports();
    try { assert.throws(() => savePreparedCache(config, next, before, f.manifest), /Injected commit failure/); }
    finally { rename.mock.restore(); syncBuiltinESMExports(); }
    assert.deepEqual(readManifestBytes(f.manifest), before);
    assert.deepEqual(readPreparedCache(config, f.manifest), previous);
    assert.deepEqual(readdirSync(f.root).sort(), files);
  } finally { assertStopped(f); f.remove(); }
});

test("stopping during startup cannot open the next server", async () => {
  const f = fixture();
  let loaded;
  try {
    assert.equal((await prepare(f)).code, 0);
    loaded = await load(f);
    const original = Client.prototype.listTools;
    let stopped = false;
    const listing = mock.method(Client.prototype, "listTools", async function (...args) {
      const result = await original.apply(this, args);
      if (!stopped) { stopped = true; await loaded.service.stop(); }
      return result;
    });
    try { await assert.rejects(loaded.service.start(), /stopped during startup/); }
    finally { listing.mock.restore(); }
    assertStopped(f);
  } finally {
    if (loaded) await loaded.service.stop();
    assertStopped(f);
    f.remove();
  }
});

test("concurrent manifest edits are preserved rather than overwritten", async () => {
  const f = fixture();
  try {
    assert.equal((await prepare(f)).code, 0);
    const before = readManifestBytes(f.manifest);
    const cache = readPreparedCache(parseConfig(f.config), f.manifest);
    const changed = { ...JSON.parse(before), description: "Concurrent edit" };
    writeFileSync(f.manifest, JSON.stringify(changed));
    assert.throws(() => savePreparedCache(parseConfig(f.config), cache, before, f.manifest), /changed during discovery/);
    assert.deepEqual(JSON.parse(readManifestBytes(f.manifest)), changed);
    assert(!existsSync(join(f.root, ".mcp-prepare.lock")));
  } finally { assertStopped(f); f.remove(); }
});

test("recreating a missing referenced cache reports changed and supports reload", async () => {
  const f = fixture();
  let loaded;
  try {
    assert.equal((await prepare(f)).code, 0);
    const before = readManifestBytes(f.manifest);
    rmSync(join(f.root, JSON.parse(before).mcpToolCache));
    await assert.rejects(load(f, "?missing-cache"), { code: "ENOENT" });
    const repaired = await prepare(f);
    assert.equal(repaired.code, 0, repaired.stderr);
    assert.equal(JSON.parse(repaired.stdout).changed, true);
    assert.deepEqual(readManifestBytes(f.manifest), before);
    loaded = await load(f, "?repaired-cache");
    await loaded.service.start();
    assert.equal((await loaded.tools[0].execute("repaired", {})).content[0].text, "fixture-result");
  } finally {
    if (loaded) await loaded.service.stop();
    assertStopped(f);
    f.remove();
  }
});

test("same-name server configuration changes cannot reuse prepared schemas", async () => {
  const f = fixture();
  try {
    assert.equal((await prepare(f)).code, 0);
    for (const replacement of [
      { command: "/other/mcp-server" }, { args: ["other-server.mjs"] }, { cwd: "/other/workspace" },
      { transport: "http", url: "https://other.example/mcp" },
      { env: { ...f.config.servers[0].env, TOOL_NAMES: '["different_tool"]' } },
      { headers: { Authorization: "Bearer fixture-private-replacement" } },
    ]) {
      const changed = structuredClone(f.config);
      Object.assign(changed.servers[0], replacement);
      assert.throws(() => readPreparedCache(parseConfig(changed), f.manifest), /configuration changed/);
    }
    const reordered = structuredClone(f.config);
    reordered.servers.reverse();
    reordered.servers[0].env = Object.fromEntries(Object.entries(reordered.servers[0].env).reverse());
    reordered.servers[0].timeout = 1500;
    readPreparedCache(parseConfig(reordered), f.manifest);
  } finally { assertStopped(f); f.remove(); }
});

test("changed server names, prefix mode and colliding names require preparation", async () => {
  const f = fixture();
  try {
    assert.equal((await prepare(f)).code, 0);
    const before = readManifestBytes(f.manifest);
    const changed = structuredClone(f.config);
    changed.servers[1].name = "renamed";
    assert.throws(() => readPreparedCache(parseConfig(changed), f.manifest), /server names changed/);
    changed.servers[1].name = "github-test";
    changed.toolPrefix = false;
    assert.throws(() => readPreparedCache(parseConfig(changed), f.manifest), /does not match/);
    const collision = await prepare(f, changed);
    assert.notEqual(collision.code, 0);
    assert.deepEqual(readManifestBytes(f.manifest), before);
  } finally { assertStopped(f); f.remove(); }
});

test("tool and shutdown errors do not expose private server diagnostics", async () => {
  const f = fixture();
  let loaded;
  try {
    assert.equal((await prepare(f)).code, 0);
    f.setMode(0, "tool-error");
    loaded = await load(f);
    await loaded.service.start();
    await assert.rejects(loaded.tools[0].execute("error", {}), error => {
      assert(!inspect(error).includes("fixture-private-"), "Tool error exposed a credential");
      return true;
    });
    const close = mock.method(StdioClientTransport.prototype, "close", async () => { throw new Error("fixture-private-close"); });
    try {
      await assert.rejects(loaded.service.stop(), error => {
        assert(!inspect(error).includes("fixture-private-"), "Shutdown error exposed a credential");
        return true;
      });
    } finally { close.mock.restore(); }
  } finally {
    if (loaded) await loaded.service.stop();
    assertStopped(f);
    f.remove();
  }
});

test("CLI rejects malformed private input and suppresses server stderr", async () => {
  const f = fixture();
  try {
    const before = readManifestBytes(f.manifest);
    assert.notEqual((await prepare(f, '{"token":"fixture-private-malformed')).code, 0);
    assert.notEqual((await prepare(f, "[]")).code, 0);
    assert.deepEqual(readManifestBytes(f.manifest), before);
    f.setMode(0, "stderr");
    assert.equal((await prepare(f)).code, 0);
  } finally { assertStopped(f); f.remove(); }
});
