#!/usr/bin/env node
import { parseConfig } from "./config.js";
import { McpClientPool } from "./mcp-client.js";
import { configurationHash, getManifestPath, readManifestBytes, savePreparedCache, type ToolCache } from "./prepared-cache.js";

let phase = "reading plugin config from stdin";
try {
  if (process.stdin.isTTY) throw new Error("Pipe a private plugin config JSON object to stdin");
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const raw: unknown = JSON.parse(input);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Plugin config must be a JSON object");
  phase = "validating plugin config";
  const config = parseConfig(raw);
  const names = config.servers.map((server) => server.name);
  if (new Set(names).size !== names.length) throw new Error("MCP server names must be unique");
  const manifestPath = getManifestPath();
  const before = readManifestBytes(manifestPath);
  const cache: ToolCache = { version: 2, toolPrefix: config.toolPrefix,
    configurationHash: configurationHash(config), servers: Object.create(null),
  };
  const pool = new McpClientPool();
  phase = "discovering configured MCP tools";
  try {
    for (const server of config.servers) {
      await pool.connect(server);
      const tools = await pool.listTools(server.name);
      cache.servers[server.name] = tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? `Tool from ${server.name}`,
        inputSchema: tool.inputSchema,
      }));
    }
    phase = "closing discovery connections";
  } finally {
    await pool.closeAll();
  }
  phase = "committing tool cache and contracts";
  const changed = savePreparedCache(config, cache, before, manifestPath);
  process.stdout.write(JSON.stringify({ prepared: true, changed, servers: config.servers.length,
    tools: Object.values(cache.servers).reduce((total, tools) => total + tools.length, 0),
  }) + "\n");
} catch (error) {
  // Input, parser errors and server diagnostics may contain credential values.
  console.error(`MCP preparation failed while ${phase}; raw diagnostics withheld to protect credentials`);
  if ((error as NodeJS.ErrnoException | null)?.code === "MCP_PREPARATION_LOCKED") {
    console.error("Stop the gateway and verify no preparation process is running before removing .mcp-prepare.lock from the plugin directory, then prepare again.");
  }
  process.exitCode = 1;
}
