# Advanced Configuration

## Shared Core and Remote Mode

By default, each AI harness starts a small stdio adapter. The first adapter starts one persistent background core on port `16384`; every other adapter connects to that same core. The core owns the Roblox bridge, dashboard, decompiler processes, and MCP tool sessions.

### Remote primary (`--baseurl`)

If your AI client runs on macOS/Linux but Roblox is on a Windows machine, its stdio adapter can connect directly to the Windows background core:

```json
{
  "mcpServers": {
    "roblox-executor-mcp": {
      "command": "node",
      "args": [
        "/path/to/roblox-executor-mcp/dist/index.js",
        "--baseurl",
        "http://<windows-ip>:16384"
      ]
    }
  }
}
```

**Fallback behavior:**

| Scenario | Result |
|---|---|
| Remote reachable | Adapter connects to the remote background core |
| Remote unreachable | Adapter falls back to the local background core |
| Local core already running | Adapter reuses the existing local core |

Because tools execute in the selected background core, `screenshot-window` and `list-roblox-windows` run on the remote Windows host when `--baseurl` is connected.

## Connector Options

Set these in Roblox **before** running the connector:

| Variable | Default | Description |
|---|---|---|
| `getgenv().BridgeURL` | `localhost:16384` | Server address to connect to |
| `getgenv().DisableWebSocket` | `false` | Force HTTP polling instead of WebSocket |
| `getgenv().DisableInitialScriptDecompMapping` | `false` | Skip decompiling all scripts on connect |
| `getgenv().MCP_FailedScriptResyncInterval` | `30` | Seconds before the first failed-script resync; repeated failures back off to five minutes |
| `getgenv().MCP_FailedScriptResyncBatchSize` | `8` | Maximum failed scripts queued by one periodic resync tick |

Failed script mappings are retried automatically in bounded batches. A resync prioritizes the provider that the original attempt actually reached, then uses the configured provider order as fallback.

The connector supports two transport modes:
- **WebSocket** (preferred) — persistent connection, lower latency
- **HTTP Polling** — fallback for executors that don't support WebSocket

## Dashboard

A live status dashboard is available at `http://localhost:16384/` when the server is running. It shows connected clients, server role, and uptime.

Under **Settings → Decompiler fallbacks**, choose **Add provider → Custom provider** to add an HTTP decompiler to the fallback chain. You can add multiple custom providers; each keeps an independent workflow, fallback position, endpoint, authentication, headers, timeout, and health state. The custom-provider editor uses a pannable, zoomable node canvas: add blocks, drag them into place, and connect their ports to define the bytecode-to-source path. Bytecode and Source are permanent boundary blocks. Use Set Variable to name the current raw or base64 value, then reference it in the Request headers or body with `{{variable_name}}`; the optional API key is available as `{{api_key}}`. Type `{{` for autocomplete, use the arrow keys to choose a variable, and press Enter or Tab to insert it. Undo and redo are available from the toolbar or with Command/Ctrl+Z, Command/Ctrl+Shift+Z, and Ctrl+Y. The Request response port can connect directly to Source for plain text or through Parse JSON for a configurable dot-path field.

## Security

**This server allows arbitrary code execution.** Any connected AI client can run Lua code in your Roblox session, take screenshots, and read client data.

**Never expose port `16384` to the internet.** There is no authentication. For cross-machine setups:

- Use a **local network** or **VPN**
- Use an **SSH tunnel**: `ssh -L 16384:localhost:16384 user@windows-machine`
- **Never** forward the port through a public router or cloud firewall
