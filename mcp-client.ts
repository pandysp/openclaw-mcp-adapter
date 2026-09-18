import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ServerConfig } from "./config.js";

interface ToolSchema {
  type?: string;
  properties?: Record<string, { type?: string }>;
  required?: string[];
}

interface ClientEntry {
  config: ServerConfig;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  connected: boolean;
  closed: Promise<void>;
  toolSchemas: Map<string, ToolSchema>;
}

export class McpClientPool {
  private clients = new Map<string, ClientEntry>();
  private connecting = new Map<string, Promise<Client>>();

  async connect(config: ServerConfig): Promise<Client> {
    const pending = this.connecting.get(config.name);
    if (pending) return pending;
    const current = this.clients.get(config.name);
    if (current?.connected) return current.client;

    const opening = this.open(config);
    this.connecting.set(config.name, opening);
    try {
      return await opening;
    } finally {
      this.connecting.delete(config.name);
    }
  }

  private async open(config: ServerConfig): Promise<Client> {
    const previous = this.clients.get(config.name);
    if (previous) await this.closeEntry(config.name, previous);

    const client = new Client({ name: "openclaw-mcp-adapter", version: "0.1.0" });
    const transport = this.createTransport(config);
    if (transport instanceof StdioClientTransport) {
      // Server stderr can contain credentials. Drain it without forwarding raw
      // data; connection/request errors still propagate through the SDK.
      transport.stderr?.once("data", () => console.error(`[mcp-adapter] ${config.name} emitted diagnostic output (withheld)`));
      transport.stderr?.on("data", () => {});
    }
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const entry: ClientEntry = { config, client, transport, connected: false, closed, toolSchemas: new Map() };
    this.clients.set(config.name, entry);

    // Use client callbacks: replacing transport.onclose bypasses the SDK's
    // rejection of pending requests when a server disconnects.
    client.onclose = () => {
      entry.connected = false;
      resolveClosed();
    };
    client.onerror = () => {
      console.error(`[mcp-adapter] ${config.name} transport error`);
    };
    try {
      await client.connect(transport);
      entry.connected = true;
      return client;
    } catch (err) {
      try {
        await this.closeEntry(config.name, entry);
      } catch (closeError) {
        throw new AggregateError([err, closeError], `MCP server ${config.name} failed to connect and close`);
      }
      throw err;
    }
  }

  private createTransport(config: ServerConfig) {
    if (config.transport === "http") {
      return new StreamableHTTPClientTransport(new URL(config.url!), {
        requestInit: { headers: config.headers },
      });
    }
    return new StdioClientTransport({
      command: config.command!,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
      stderr: "pipe",
    });
  }

  async listTools(serverName: string) {
    const entry = this.clients.get(serverName);
    if (!entry) throw new Error(`Unknown server: ${serverName}`);
    const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await entry.client.listTools(cursor === undefined ? undefined : { cursor });
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (cursors.has(cursor)) throw new Error(`MCP server ${serverName} repeated a tool-list cursor`);
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    entry.toolSchemas.clear();
    for (const tool of tools) {
      if (tool.inputSchema) {
        entry.toolSchemas.set(tool.name, tool.inputSchema as ToolSchema);
      }
    }
    return tools;
  }

  async callTool(serverName: string, toolName: string, args: unknown) {
    const entry = this.clients.get(serverName);
    if (!entry) throw new Error(`Unknown server: ${serverName}`);

    this.warnOnSchemaViolations(serverName, toolName, args, entry.toolSchemas);

    const reqOpts: Record<string, unknown> = { resetTimeoutOnProgress: true, onprogress: () => {} };
    if (entry.config.timeout) reqOpts.timeout = entry.config.timeout;

    // A lost response does not mean the tool failed to execute. Never replay
    // an ambiguous call; a later, explicit invocation may reconnect instead.
    return await entry.client.callTool(
      { name: toolName, arguments: args as Record<string, unknown> },
      undefined,
      reqOpts,
    );
  }

  private warnOnSchemaViolations(
    serverName: string, toolName: string, args: unknown, schemas: Map<string, ToolSchema>,
  ) {
    const schema = schemas.get(toolName);
    if (!schema || typeof args !== "object" || args === null) return;

    const obj = args as Record<string, unknown>;
    const prefix = `[mcp-adapter] ${serverName}/${toolName}`;

    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in obj)) {
          console.warn(`${prefix}: missing required field "${field}"`);
        }
      }
    }

    if (schema.properties) {
      for (const [field, prop] of Object.entries(schema.properties)) {
        if (field in obj && prop.type && obj[field] !== null && obj[field] !== undefined) {
          const actual = typeof obj[field];
          const expected = prop.type === "integer" ? "number" : prop.type;
          if (actual !== expected) {
            console.warn(`${prefix}: field "${field}" expected ${prop.type}, got ${actual}`);
          }
        }
      }
    }
  }

  getStatus(serverName: string) {
    const entry = this.clients.get(serverName);
    return { connected: entry?.connected ?? false };
  }

  private async closeEntry(serverName: string, entry: ClientEntry) {
    const pid = entry.transport instanceof StdioClientTransport ? entry.transport.pid : null;
    await entry.transport.close();
    if (pid !== null) {
      // SDK close() can return immediately after SIGKILL. Wait for its actual
      // close event before reporting that the owned subprocess has stopped.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP server ${serverName} did not close`)), 1000);
        timer.unref();
        entry.closed.then(() => { clearTimeout(timer); resolve(); });
      });
    }
    entry.connected = false;
    if (this.clients.get(serverName) === entry) this.clients.delete(serverName);
  }

  async close(serverName: string) {
    const pending = this.connecting.get(serverName);
    if (pending) await pending;
    const entry = this.clients.get(serverName);
    if (entry) await this.closeEntry(serverName, entry);
  }

  async closeAll() {
    const pending = await Promise.allSettled(this.connecting.values());
    const closing = await Promise.allSettled(
      [...this.clients].map(([name, entry]) => this.closeEntry(name, entry)),
    );
    const failures = [...pending, ...closing].filter((result) => result.status === "rejected");
    if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), "MCP connections failed to close");
  }
}
