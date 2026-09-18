import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpAdapterConfig } from "./config.js";

export interface CachedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCache {
  version: 2;
  toolPrefix: boolean;
  configurationHash: string;
  servers: Record<string, CachedTool[]>;
}

interface PreparedManifest {
  id: string;
  contracts?: { tools?: string[]; [key: string]: unknown };
  mcpToolCache?: string;
  [key: string]: unknown;
}

export function getManifestPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  for (const root of [moduleDir, dirname(moduleDir)]) {
    const path = join(root, "openclaw.plugin.json");
    if (existsSync(path)) return path;
  }
  throw new Error("MCP adapter manifest not found beside the entrypoint or its parent");
}

function digest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function configurationHash(config: McpAdapterConfig): string {
  // Discovery can depend on arguments, environment and HTTP authorization.
  // Keep only a digest; never copy those credential-bearing values into cache.
  const servers = config.servers.map(({ timeout, ...server }) => ({
    ...server,
    env: Object.fromEntries(Object.entries(server.env ?? {}).sort()),
    headers: Object.fromEntries(Object.entries(server.headers ?? {}).sort()),
  })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return digest(JSON.stringify(servers));
}

export function toolNames(config: McpAdapterConfig, cache: ToolCache): string[] {
  if (cache.version !== 2 || cache.toolPrefix !== config.toolPrefix || !cache.servers || typeof cache.servers !== "object") {
    throw new Error("MCP tool cache does not match this configuration; run openclaw-mcp-prepare again");
  }
  const configured = config.servers.map((server) => server.name).sort();
  if (new Set(configured).size !== configured.length || JSON.stringify(configured) !== JSON.stringify(Object.keys(cache.servers).sort())) {
    throw new Error("MCP server names changed or are duplicated; run openclaw-mcp-prepare again");
  }
  if (cache.configurationHash !== configurationHash(config)) {
    throw new Error("MCP server configuration changed; run openclaw-mcp-prepare again");
  }
  const names: string[] = [];
  for (const server of config.servers) {
    const tools = cache.servers[server.name];
    if (!Array.isArray(tools)) throw new Error(`Invalid prepared tools for MCP server ${server.name}`);
    for (const tool of tools) {
      if (typeof tool.name !== "string" || !tool.name || typeof tool.description !== "string" ||
          !tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
        throw new Error(`Invalid prepared tool for MCP server ${server.name}`);
      }
      names.push(config.toolPrefix ? `${server.name}_${tool.name}` : tool.name);
    }
  }
  if (new Set(names).size !== names.length) throw new Error("MCP tool names collide; enable prefixes or use distinct tool names");
  return names;
}

function readOwnedFile(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`MCP preparation requires an owned regular file: ${path}`);
  }
  return readFileSync(path);
}

export function readPreparedCache(config: McpAdapterConfig, manifestPath = getManifestPath()): ToolCache {
  const manifest = JSON.parse(readOwnedFile(manifestPath).toString("utf8")) as PreparedManifest;
  const filename = manifest.mcpToolCache;
  if (!filename || !/^\.tool-cache-[a-f0-9]{64}\.json$/.test(filename)) {
    throw new Error("MCP tools are not prepared; pipe the plugin config to openclaw-mcp-prepare before enabling the plugin");
  }
  const bytes = readOwnedFile(join(dirname(manifestPath), filename));
  if (filename !== `.tool-cache-${digest(bytes)}.json`) throw new Error("MCP tool cache checksum differs from the prepared manifest");
  const cache = JSON.parse(bytes.toString("utf8")) as ToolCache;
  const names = toolNames(config, cache).sort();
  const contracts = manifest.contracts?.tools;
  if (!Array.isArray(contracts) || JSON.stringify([...contracts].sort()) !== JSON.stringify(names)) {
    throw new Error("MCP tool contracts differ from the prepared cache; run openclaw-mcp-prepare again");
  }
  return cache;
}

// Prepare only during exclusive maintenance with the gateway stopped. OpenClaw
// reads contracts separately from registration, so live preparation is unsafe.
// The manifest selects a complete cache; schemas stay outside its 256 KiB limit.
export function savePreparedCache(config: McpAdapterConfig, cache: ToolCache, before: Buffer, manifestPath = getManifestPath()): boolean {
  const names = toolNames(config, cache);
  const manifest = JSON.parse(before.toString("utf8")) as PreparedManifest;
  if (manifest.id !== "openclaw-mcp-adapter") throw new Error("Unexpected MCP adapter manifest id");
  const root = dirname(manifestPath);
  const bytes = Buffer.from(JSON.stringify(cache, null, 2) + "\n");
  const filename = `.tool-cache-${digest(bytes)}.json`;
  const next = Buffer.from(JSON.stringify({ ...manifest,
    contracts: { ...manifest.contracts, tools: names }, mcpToolCache: filename,
  }, null, 2) + "\n");
  if (next.length > 256 * 1024) throw new Error("Prepared MCP tool contracts exceed OpenClaw's manifest size limit");

  const lockPath = join(root, ".mcp-prepare.lock");
  let lock: number;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw Object.assign(new Error("MCP preparation lock already exists"), { code: "MCP_PREPARATION_LOCKED" });
    }
    throw error;
  }
  const temporary = join(root, `.mcp-manifest-${randomUUID()}.tmp`);
  const temporaryCache = join(root, `.mcp-cache-${randomUUID()}.tmp`);
  const cachePath = join(root, filename);
  let createdCache = false;
  let committed = false;
  try {
    writeFileSync(lock, `${process.pid}\n`);
    if (!readOwnedFile(manifestPath).equals(before)) throw new Error("MCP manifest changed during discovery; prepare again");
    if (existsSync(cachePath)) {
      if (!readOwnedFile(cachePath).equals(bytes)) throw new Error("Existing MCP cache differs from its content address");
    } else {
      const file = openSync(temporaryCache, "wx", 0o600);
      try { writeFileSync(file, bytes); fsyncSync(file); } finally { closeSync(file); }
      renameSync(temporaryCache, cachePath);
      createdCache = true;
    }
    if (next.equals(before)) { committed = true; return createdCache; }
    const file = openSync(temporary, "wx", 0o600);
    try { writeFileSync(file, next); fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, manifestPath);
    committed = true;
    return true;
  } finally {
    closeSync(lock);
    if (existsSync(temporary)) unlinkSync(temporary);
    if (existsSync(temporaryCache)) unlinkSync(temporaryCache);
    if (createdCache && !committed) unlinkSync(cachePath);
    unlinkSync(lockPath);
  }
}

export function readManifestBytes(manifestPath = getManifestPath()): Buffer {
  return readOwnedFile(manifestPath);
}
