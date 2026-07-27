# Function guide

Always prefer the live MCP schemas over this summary.

## Read-path priority

Choose the first tool that can answer the question:

1. A specialized inspection tool.
2. `get-data-by-code` for a small custom read that must return values.
3. `execute` or `execute-file` for an intentional side effect.

Do not use `execute` plus `print` as a substitute for returned data.

## Client routing

- `list-clients`: List connected Roblox clients and their IDs.
- `set-active-client`: Route later calls to one client.

## Inspection and search

- `get-game-info`: Read place and universe metadata.
- `get-descendants-tree`: Summarize or inspect hierarchy below a root.
- `search-instances`: Find instances with `QueryDescendants` selectors. Prefer this over retrieving descendants and filtering them afterward.
- `script-grep`: Search decompiled scripts by exact text or regex.
- `semantic-search-scripts`: Find scripts by behavior when exact identifiers are unknown.
- `get-script-content`: Read one script or a focused source range.
- `get-console-output`: Read recent developer-console logs.
- `get-data-by-code`: Run a small Luau probe and return serialized raw values. The code must `return` its result.

## Execution and interaction

- `execute`: Schedule Luau for an intentional side effect; it does not return values.
- `execute-file`: Schedule a local `.luau` or `.lua` file for an intentional side effect.
- `click-button`: Fire signals on a Roblox `GuiButton`.
- `type-text-box`: Enter text into a Roblox `TextBox`.

## Remote inspection

- `remote-spy`: List, inspect, block, unblock, ignore, or unignore captured remotes.

## Windows host tools

- `list-roblox-windows`: List visible Roblox windows and PIDs on Windows.
- `screenshot-window`: Capture a selected Roblox OS window on Windows.

## Selection rules

- Known name, string, remote, or API: use `script-grep`.
- Unknown implementation but known behavior: use `semantic-search-scripts`.
- Known instance criteria: use `search-instances`.
- Unknown hierarchy: start with `get-descendants-tree` summary mode.
- Need a custom read or returned values: use `get-data-by-code`, not `execute`.
- Need an intentional side effect with no returned data: use `execute` or `execute-file`, then verify.
- Need to find GC functions or tables: use `get-data-by-code` with `filtergc`.
- Need a custom selector-expressible instance query: use `QueryDescendants` inside `get-data-by-code`.

See [runtime-patterns.md](runtime-patterns.md) for exact code patterns and fallback conditions.
