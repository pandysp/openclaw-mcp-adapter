import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mock, test } from "node:test";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpClientPool } from "../dist/mcp-client.js";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const serverSource = `
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
appendFileSync(process.env.PID_FILE, process.pid + "\\n");
const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [
  { name: "write", description: "Fixture mutation", inputSchema: { type: "object" } }
] }));
server.setRequestHandler(CallToolRequestSchema, async () => {
  appendFileSync(process.env.WRITE_FILE, "written\\n");
  if (process.env.MODE === "disconnect") setImmediate(() => process.exit(0));
  if (["disconnect", "hang"].includes(process.env.MODE)) return await new Promise(() => {});
  return { content: [{ type: "text", text: "fixture-result" }] };
});
if (process.env.MODE === "stubborn") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  process.stdin.on("end", () => process.exit(0));
}
await server.connect(new StdioServerTransport());
`;

function fixture(mode = "normal", name = "fixture") {
  const root = mkdtempSync(join(project, ".client-test-"));
  const script = join(root, "server.mjs");
  const pidFile = join(root, "pids");
  const writeFile = join(root, "writes");
  writeFileSync(script, serverSource);
  writeFileSync(pidFile, "");
  writeFileSync(writeFile, "");
  return {
    config: { name, transport: "stdio", command: process.execPath, args: [script], timeout: 150,
      env: { MODE: mode, PID_FILE: pidFile, WRITE_FILE: writeFile } },
    pids: () => readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean).map(Number),
    writes: () => readFileSync(writeFile, "utf8").trim().split("\n").filter(Boolean),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

function assertStopped(pids) {
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `Fixture subprocess ${pid} still runs`);
  }
}

for (const mode of ["disconnect", "hang"]) {
  test(`a successful mutation with a lost ${mode} response is never replayed`, async () => {
    const f = fixture(mode);
    const pool = new McpClientPool();
    try {
      await pool.connect(f.config);
      await pool.listTools(f.config.name);
      await assert.rejects(pool.callTool(f.config.name, "write", {}));
      assert.equal(f.writes().length, 1, "Ambiguous tool execution was replayed");
    } finally {
      await pool.closeAll();
      assertStopped(f.pids());
      f.remove();
    }
  });
}

test("concurrent connects share one live server", async () => {
  const f = fixture();
  const pool = new McpClientPool();
  const transports = [];
  const start = StdioClientTransport.prototype.start;
  const record = mock.method(StdioClientTransport.prototype, "start", async function () {
    transports.push(this);
    return await start.call(this);
  });
  try {
    const clients = await Promise.all([pool.connect(f.config), pool.connect(f.config)]);
    assert.equal(clients[0], clients[1]);
    assert.equal(f.pids().length, 1);
  } finally {
    record.mock.restore();
    await pool.closeAll();
    // Keep the failing baseline test from leaking the connection it overwrote.
    for (const transport of transports) await transport.close();
    assertStopped(f.pids());
    f.remove();
  }
});

test("close failures propagate without losing the live connection", async () => {
  const f = fixture();
  const pool = new McpClientPool();
  let transport;
  const start = StdioClientTransport.prototype.start;
  const record = mock.method(StdioClientTransport.prototype, "start", async function () {
    transport = this;
    return await start.call(this);
  });
  try {
    await pool.connect(f.config);
    const failure = mock.method(transport, "close", async () => { throw new Error("fixture-close-failure"); });
    try {
      await assert.rejects(pool.close(f.config.name), /fixture-close-failure/);
    } finally {
      failure.mock.restore();
    }
    await pool.close(f.config.name);
    assertStopped(f.pids());
  } finally {
    record.mock.restore();
    await pool.closeAll();
    // The old implementation dropped the map entry after swallowing the error.
    if (transport) await transport.close();
    assertStopped(f.pids());
    f.remove();
  }
});

test("close waits until an uncooperative subprocess has actually stopped", async () => {
  const f = fixture("stubborn");
  const pool = new McpClientPool();
  try {
    await pool.connect(f.config);
    await pool.closeAll();
    assertStopped(f.pids());
  } finally {
    await pool.closeAll();
    // The SDK may send SIGKILL just before resolving close(). Wait before
    // asserting fixture cleanup on the unfixed baseline too.
    await new Promise(resolve => setTimeout(resolve, 50));
    assertStopped(f.pids());
    f.remove();
  }
});
