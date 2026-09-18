import { parseConfig } from "./config.js";
import { McpClientPool } from "./mcp-client.js";
import { readPreparedCache } from "./prepared-cache.js";

// Server error messages may echo credentials. Keep the operation and numeric
// protocol code, never the raw exception or its nested causes, at the API edge.
function mcpError(operation: string, error: unknown): Error {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const detail = typeof code === "number" && Number.isInteger(code) ? ` (code ${code})` : "";
  return new Error(`MCP ${operation} failed${detail}; raw server diagnostics withheld`);
}

export default function (api: any) {
  const config = parseConfig(api.pluginConfig);

  if (config.servers.length === 0) {
    console.log("[mcp-adapter] No servers configured");
    return;
  }

  // Preparation commits the cache and exact contracts before OpenClaw loads
  // this module. Registration must be synchronous for every agent workspace.
  const cache = readPreparedCache(config);
  const pool = new McpClientPool();
  let stopped = false;
  let registered = 0;

  for (const server of config.servers) {
    for (const tool of cache.servers[server.name]) {
      api.registerTool({
        name: config.toolPrefix ? `${server.name}_${tool.name}` : tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        async execute(_id: string, params: unknown) {
          if (stopped) throw new Error("MCP adapter service is stopped");
          let operation = `${server.name} connection`;
          try {
            // Non-default agents may load a separate plugin instance whose
            // service has not started. Their first call connects lazily.
            if (!pool.getStatus(server.name).connected) {
              await pool.connect(server);
              operation = `${server.name} tool discovery`;
              await pool.listTools(server.name);
            }
            if (stopped) throw new Error("MCP adapter service is stopped");
            operation = `${server.name}/${tool.name} invocation`;
            const result = await pool.callTool(server.name, tool.name, params);
            const content = result.content as Array<{ text?: string; data?: string }>;
            return {
              content: [{ type: "text", text: content?.map((part) => part.text ?? part.data ?? "").join("\n") ?? "" }],
              isError: result.isError,
            };
          } catch (error) {
            throw mcpError(operation, error);
          }
        },
      });
      registered++;
    }
  }
  console.log(`[mcp-adapter] Registered ${registered} prepared tools`);

  // Preparation is the sole cache writer. Runtime startup only connects;
  // a failed server must not replace a complete snapshot with a partial one.
  api.registerService({
    id: "mcp-adapter",

    async start() {
      stopped = false;
      let operation = "startup";
      try {
        for (const server of config.servers) {
          operation = `${server.name} startup connection`;
          await pool.connect(server);
          if (stopped) throw new Error("MCP adapter was stopped during startup");
          operation = `${server.name} startup tool discovery`;
          await pool.listTools(server.name);
          if (stopped) throw new Error("MCP adapter was stopped during startup");
        }
      } catch (error) {
        const interrupted = stopped;
        stopped = true;
        try {
          await pool.closeAll();
        } catch (closeError) {
          throw mcpError(`${operation} and connection cleanup`, closeError);
        }
        if (interrupted) throw new Error("MCP adapter was stopped during startup");
        throw mcpError(operation, error);
      }
    },

    async stop() {
      stopped = true;
      try {
        await pool.closeAll();
      } catch (error) {
        throw mcpError("connection shutdown", error);
      }
      console.log("[mcp-adapter] All connections closed");
    },
  });
}
