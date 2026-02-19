import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parseConfig } from "./config.js";
import { McpClientPool } from "./mcp-client.js";

interface CachedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolCache {
  version: number;
  servers: Record<string, CachedTool[]>;
}

const CACHE_VERSION = 1;

function getCachePath(): string {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), ".tool-cache.json");
  } catch {
    return join(process.env.HOME ?? "/tmp", ".openclaw", "extensions", "openclaw-mcp-adapter", ".tool-cache.json");
  }
}

function readCache(): ToolCache | null {
  const cachePath = getCachePath();
  try {
    if (!existsSync(cachePath)) return null;
    const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (raw?.version !== CACHE_VERSION) return null;
    return raw as ToolCache;
  } catch {
    return null;
  }
}

function writeCache(cache: ToolCache): void {
  try {
    writeFileSync(getCachePath(), JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error("[mcp-adapter] Failed to write tool cache:", err);
  }
}

export default function (api: any) {
  const config = parseConfig(api.pluginConfig);

  if (config.servers.length === 0) {
    console.log("[mcp-adapter] No servers configured");
    return;
  }

  const pool = new McpClientPool();
  const cache = readCache();

  // Phase 1: Register tools synchronously from cache (if available).
  // This makes tools available to ALL agents, not just the default.
  // Root cause: OpenClaw's plugin registry is keyed by workspaceDir.
  // Non-default agents have different workspaces, causing cache misses
  // that re-load plugins from scratch — losing service-registered tools.
  if (cache) {
    let registered = 0;
    for (const server of config.servers) {
      const cachedTools = cache.servers[server.name];
      if (!cachedTools) continue;

      for (const tool of cachedTools) {
        const toolName = config.toolPrefix ? `${server.name}_${tool.name}` : tool.name;

        api.registerTool({
          name: toolName,
          description: tool.description ?? `Tool from ${server.name}`,
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
          async execute(_id: string, params: unknown) {
            // Lazy connect on first tool call
            if (!pool.getStatus(server.name).connected) {
              console.log(`[mcp-adapter] Lazy-connecting to ${server.name}...`);
              await pool.connect(server);
              await pool.listTools(server.name);
            }
            const result = await pool.callTool(server.name, tool.name, params);
            const content = result.content as Array<{ text?: string; data?: string }>;
            const text = content
              ?.map((c) => c.text ?? c.data ?? "")
              .join("\n") ?? "";
            return {
              content: [{ type: "text", text }],
              isError: result.isError,
            };
          },
        });
        registered++;
      }
    }
    console.log(`[mcp-adapter] Registered ${registered} tools from cache`);
  }

  // Phase 2: Service lifecycle — connects to servers, discovers tools,
  // and updates the cache for future plugin loads.
  api.registerService({
    id: "mcp-adapter",

    async start() {
      const newCache: ToolCache = { version: CACHE_VERSION, servers: {} };
      let serviceRegistered = 0;

      for (const server of config.servers) {
        try {
          console.log(`[mcp-adapter] Connecting to ${server.name}...`);
          await pool.connect(server);

          const tools = await pool.listTools(server.name);
          console.log(`[mcp-adapter] ${server.name}: found ${tools.length} tools`);

          newCache.servers[server.name] = tools.map((t: any) => ({
            name: t.name,
            description: t.description ?? `Tool from ${server.name}`,
            inputSchema: t.inputSchema ?? { type: "object", properties: {} },
          }));

          // If not already registered from cache, register now (for default agent)
          if (!cache || !cache.servers[server.name]) {
            for (const tool of tools) {
              const toolName = config.toolPrefix ? `${server.name}_${tool.name}` : tool.name;

              api.registerTool({
                name: toolName,
                description: tool.description ?? `Tool from ${server.name}`,
                parameters: tool.inputSchema ?? { type: "object", properties: {} },
                async execute(_id: string, params: unknown) {
                  const result = await pool.callTool(server.name, tool.name, params);
                  const content = result.content as Array<{ text?: string; data?: string }>;
                  const text = content
                    ?.map((c) => c.text ?? c.data ?? "")
                    .join("\n") ?? "";
                  return {
                    content: [{ type: "text", text }],
                    isError: result.isError,
                  };
                },
              });

              console.log(`[mcp-adapter] Registered: ${toolName}`);
              serviceRegistered++;
            }
          }
        } catch (err) {
          console.error(`[mcp-adapter] Failed to connect to ${server.name}:`, err);
        }
      }

      writeCache(newCache);
      if (serviceRegistered > 0) {
        console.log(`[mcp-adapter] Service registered ${serviceRegistered} new tools`);
      }
      console.log(`[mcp-adapter] Tool cache updated at ${getCachePath()}`);
    },

    async stop() {
      console.log("[mcp-adapter] Shutting down...");
      await pool.closeAll();
      console.log("[mcp-adapter] All connections closed");
    },
  });
}
