# MCP Adapter (OpenClaw Plugin)

Exposes MCP (Model Context Protocol) server tools as native OpenClaw agent tools.

Instead of running MCP servers through a CLI skill, this plugin registers each MCP tool as a first-class tool that agents can invoke directly. Prepare the tool catalog before enabling the plugin: OpenClaw requires exact tool-name contracts before runtime registration.

## Requirements

- OpenClaw gateway (tested with 2026.6.6)
- Node.js 18+
- MCP servers you want to connect to
- `jq` for the configuration-extraction example below

## Installation and upgrades

Use an exclusive maintenance window: finish active turns, stop the gateway, then install and prepare before restarting it. Do not prepare tools while a gateway or another preparation process is using the plugin. OpenClaw reads tool contracts before loading the plugin; keeping old cache files does not make live preparation safe.

Run these steps in the same shell as the gateway's user. This assumes OpenClaw is already configured. Save the global plugin policy so installation cannot enable unprepared tools (the installer automatically enables the individual plugin):

```bash
set -euo pipefail
policy=$(jq -ce '(.plugins // {}) | {present: has("enabled"), enabled: .enabled}' ~/.openclaw/openclaw.json)
openclaw gateway stop --json
openclaw config set plugins.enabled false
openclaw plugins install --force --pin @pandysp/openclaw-mcp-adapter@0.1.7
```

For source installs, replace the last command with `openclaw plugins install --force ./openclaw-mcp-adapter`. Complete configuration and preparation below before restoring plugin loading or restarting the gateway.

## Configuration

### 1. Configure servers with the plugin disabled

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-mcp-adapter": {
        "enabled": false,
        "config": {
          "servers": [
            {
              "name": "myserver",
              "transport": "stdio",
              "command": "npx",
              "args": ["-y", "some-mcp-server"],
              "env": {
                "API_KEY": "${MY_API_KEY}"
              }
            }
          ]
        }
      }
    }
  }
}
```

### 2. Prepare the tool catalog

Run as the user who owns the installed plugin, with any referenced environment variables loaded. The command takes the plugin's `config` object on stdin; it does not load `.env` files itself.

```bash
(
  set -euo pipefail
  plugin_dir=$(openclaw plugins inspect openclaw-mcp-adapter --json | jq -er '.install.installPath | select(type == "string" and length > 0)')
  config=$(jq -ce '.plugins.entries["openclaw-mcp-adapter"].config | select(type == "object")' ~/.openclaw/openclaw.json)
  printf '%s' "$config" | node "$plugin_dir/dist/prepare.js"
)
```

If installed globally with npm, the same command is available as `openclaw-mcp-prepare`. For provisioning, feed an existing private plugin-config JSON file directly to stdin. Do not put credential values in command arguments.

Preparation connects to every configured server, discovers tools, closes the connections, then commits the complete catalog and exact contracts. Any discovery or pre-commit write failure leaves the previous catalog selected. Re-run preparation after changing servers, prefixes, credentials, environment values or server tool definitions. The cache binds to a digest of the resolved server configuration without storing credential values. Changing only a request timeout does not require preparation. Preparation is also required after reinstalling/updating the plugin.

### 3. Enable and restart

Configure the usual OpenClaw tool policies for each agent. Preparation declares available tools; it does not grant access across agents or repositories.

```bash
openclaw plugins enable openclaw-mcp-adapter
if [ "$(printf '%s' "$policy" | jq -r .present)" = true ]; then
  openclaw config set plugins.enabled "$(printf '%s' "$policy" | jq -c .enabled)"
else
  openclaw config unset plugins.enabled
fi
openclaw gateway start
```

If preparation fails, leave the gateway stopped. Disable the adapter with `openclaw plugins disable openclaw-mcp-adapter`, restore the saved global policy using the block above, and fix the reported failure before retrying. Do not save the temporary global `false` as the intended policy on a retry.

An interrupted writer can leave `.mcp-prepare.lock` in the installation directory. Only after confirming the gateway and every preparation process are stopped, remove that lock and run preparation again. Locks are never stolen automatically. Interrupted cache writes cannot select an incomplete catalog.

### 4. Verify

```bash
openclaw plugins inspect openclaw-mcp-adapter --runtime --json
```

Check the running gateway's tool catalog and invoke an allowed tool as each agent. A plugin inspection alone does not prove the running gateway has reloaded it.

## Server Configuration

### Stdio transport (spawns a subprocess)

```json
{
  "name": "filesystem",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@anthropic/mcp-filesystem", "/path/to/dir"],
  "env": {
    "SOME_VAR": "value"
  }
}
```

### HTTP transport (connects to a running server)

```json
{
  "name": "api",
  "transport": "http",
  "url": "http://localhost:3000/mcp",
  "allowPrivateUrls": true,
  "headers": {
    "Authorization": "Bearer ${API_TOKEN}"
  }
}
```

## Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `servers` | array | `[]` | List of MCP servers to connect to |
| `toolPrefix` | boolean | `true` | Prefix tool names with server name (e.g., `myserver_toolname`) |

### Server Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | string | Yes | Unique name for this server |
| `transport` | `"stdio"` \| `"http"` | No | Connection type (default: `stdio`) |
| `command` | string | stdio only | Command to spawn |
| `args` | string[] | No | Command arguments |
| `env` | object | No | Environment variables |
| `url` | string | http only | Server URL |
| `headers` | object | No | HTTP request headers |
| `allowPrivateUrls` | boolean | No | Allow HTTP servers on private/local addresses (default `false`) |
| `timeout` | number | No | Tool-call timeout in milliseconds |

## Environment Variable Interpolation

Use `${VAR_NAME}` in `env` and `headers` values to reference environment variables. They must be available to both preparation and the gateway. A missing variable is an error; preparation does not implicitly source `~/.openclaw/.env`:

```json
{
  "env": {
    "API_KEY": "${MY_SERVICE_API_KEY}"
  }
}
```

## How It Works

1. Preparation writes an immutable, content-addressed tool cache, then atomically selects it in the manifest alongside its exact contracts. Tool schemas stay outside OpenClaw's size-limited manifest.
2. On plugin load, tools register synchronously from that snapshot for every agent workspace. Runtime startup never rewrites the catalog.
3. Startup connects to configured servers; separate agent instances can also connect lazily on their first invocation.
4. Tool calls are forwarded once. A lost response is reported, never replayed automatically: a write may already have succeeded. A later explicit invocation can reconnect.
5. Service shutdown closes all connections and reports failures. Old cache snapshots remain available to readers during reloads; do not remove them while the gateway may still use them.

## Example: AgentMail

```json
{
  "name": "agentmail",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "agentmail-mcp"],
  "env": {
    "AGENTMAIL_API_KEY": "${AGENTMAIL_API_KEY}"
  }
}
```

This registers tools like `agentmail_create_inbox`, `agentmail_send_email`, etc.

## License

MIT
