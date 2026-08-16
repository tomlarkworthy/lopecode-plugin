# @lopecode/channel

Pair program with Claude Code inside [Lopecode](https://tomlarkworthy.github.io/lopecode/) notebooks. An MCP server that bridges browser-based Observable notebooks and Claude Code via WebSocket, enabling real-time collaboration: chat, define cells, watch reactive variables, run tests, and manipulate the DOM — all from inside the notebook.

## Quick Start

Two commands, Node 20+, nothing global:

```bash
claude mcp add lopecode -- npx -y @lopecode/channel
claude --dangerously-load-development-channels server:lopecode
```

Then ask Claude: **"Open a lopecode notebook"**. Claude gets a pairing token, opens the
notebook in your browser, and auto-connects.

The second command is what makes the pairing two-way, and it is worth understanding before
you paste it. Claude driving the notebook — `define_cell`, `run_tests`, everything in the
tool table below — needs only the first command. The notebook driving *Claude* — the chat
box, `variable_update` and `cell_change` arriving in Claude's context unprompted — is a
separate Claude Code capability (`experimental: { "claude/channel": {} }`) behind an
allowlist that this plugin is not on. The flag's own help says it "is for local channel
development only. Do not use this option to run channels you have downloaded off the
internet," and installing from npm is exactly that. It is the only route to inbound push
for an individual user today; the alternatives, and why they do not help yet, are in
[Inbound push without the flag](#inbound-push-without-the-flag).

The flag applies per launch, so in practice:

```bash
alias claude-lope='claude --dangerously-load-development-channels server:lopecode'
```

Leave it off and nothing breaks — Claude → notebook still works, and typing in the notebook
chat box reaches nobody. The channel notices that case: if it forwards a message and sees no
response for 40 seconds it writes the reason, and this command, into the notebook chat.

### Pairing a notebook you did not open locally

The notebook does not have to be a local file: a notebook served from any origin (e.g.
`https://tomlarkworthy.github.io/lopecode/notebooks/…`) can pair with your local channel over
`ws://127.0.0.1`. Paste the pairing token into the `@tomlarkworthy/claude-code-pairing` panel,
or let Claude open the URL with `&cc=TOKEN`.

Chrome 151 gates that connection behind the Local Network Access permission
(`LocalNetworkAccessChecksWebSockets`); a blocked one fails with
`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` in the console — allow local network access for
the site when prompted. Headless Chrome refuses it outright, so `verify-https-pairing.mjs`
turns the gate off (`LOPE_E2E_DISABLE_LNA=1`) and keeps a gated run as an informational probe.

### Install as a plugin instead

```
/plugin marketplace add tomlarkworthy/lopecode-plugin
/plugin install lopecode-channel@lopecode-plugins
```

This repository is both the marketplace and the plugin. `dist/` is committed so the install
is a clone with no build step. The plugin declares its channel in `plugin.json`:

```json
"channels": [{ "server": "lopecode", "displayName": "Lopecode" }]
```

Installing as a plugin does not by itself remove the flag — see below.

### Inbound push without the flag

`--channels` takes tagged entries, and the tag decides which gate applies:

```
server:lopecode                              an MCP server (claude mcp add, or .mcp.json)
plugin:lopecode-channel@lopecode-plugins     a plugin-provided channel
```

Only the `plugin:` form can reach the allowlist at all; a plugin-installed server selected as
`server:…` still takes the server path and still needs the development flag. The allowlist
itself is read from **managed settings only** — not `~/.claude/settings.json` — so
self-allowlisting means writing a root-owned file:

```jsonc
// macOS: /Library/Application Support/ClaudeCode/managed-settings.json
// Linux: /etc/claude-code/managed-settings.json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "lopecode-plugins", "plugin": "lopecode-channel" }
  ]
}
```

`channelsEnabled` is not redundant there. Claude Code's own description of it reads
"claude.ai Teams/Enterprise: default off. Console: default on unless managed settings exist" —
so a Console user who creates this file for the allowlist alone turns the whole feature off.

Then:

```bash
claude --channels plugin:lopecode-channel@lopecode-plugins
```

This path is **untested** — it is read off the gate's behaviour in Claude Code 2.1.233, not
run end to end. The development flag above is the path that has actually been used.

### Development

`src/lopecode-channel.ts` is the source of truth; `dist/` is generated from it.
Bun runs the TypeScript directly, so there is no build step in the edit loop:

```bash
npm install                       # devDependencies (esbuild, ws, MCP SDK)
bun run src/lopecode-channel.ts   # run from source
bun run build.ts                  # regenerate dist/
bun test ./tests/lopecode-channel.test.ts

node verify-node-build.mjs                        # MCP handshake + WebSocket pairing, dist/
node verify-node-build.mjs bun src/lopecode-channel.ts   # same, against the source
node verify-https-pairing.mjs                     # pairs a github.io notebook to a local server
```

To point a Claude Code session at a working copy rather than the published plugin:

```bash
claude --plugin-dir /path/to/lopecode-plugin
```

## What is Lopecode?

Lopecode notebooks are self-contained HTML files built on the [Observable runtime](https://github.com/observablehq/runtime). Each notebook contains:

- **Modules** — collections of reactive cells (code units)
- **Embedded dependencies** — everything needed to run, in a single file
- **A multi-panel UI** (lopepage) — view and edit multiple modules side by side

The Observable runtime provides **reactive dataflow**: cells automatically recompute when their dependencies change, similar to a spreadsheet.

## How Pairing Works

```
Browser (Notebook)  ←→  WebSocket  ←→  Channel Server (Node)  ←→  MCP stdio  ←→  Claude Code
```

1. The channel server starts a local WebSocket server and generates a pairing token (`LOPE-PORT-XXXX`)
2. Claude opens a notebook URL with `&cc=TOKEN` in the hash
3. The notebook auto-connects to the WebSocket server
4. Claude can now use MCP tools to interact with the live notebook

## Observable Cell Syntax

Lopecode cells use [Observable JavaScript](https://observablehq.com/@observablehq/observable-javascript) syntax. Here's what you need to know:

### Named Cells

```javascript
// A cell is a named expression. It re-runs when dependencies change.
x = 42
greeting = `Hello, ${name}!`   // depends on the 'name' cell
```

### Markdown

```javascript
// Use the md tagged template literal for rich text
md`# My Title

Some **bold** text and a list:
- Item 1
- Item 2
`
```

### HTML

```javascript
// Use htl.html for DOM elements
htl.html`<div style="color: red">Hello</div>`
```

### Imports

```javascript
// Import from other modules in the notebook
import {md} from "@tomlarkworthy/editable-md"
import {chart} from "@tomlarkworthy/my-visualization"
```

### viewof — Interactive Inputs

```javascript
// viewof creates two cells:
//   "viewof slider" — the DOM element (a range input)
//   "slider" — the current value (a number)
viewof slider = Inputs.range([0, 100], {label: "Value", value: 50})

// Other cells can depend on the value
doubled = slider * 2
```

Common inputs: `Inputs.range`, `Inputs.select`, `Inputs.text`, `Inputs.toggle`, `Inputs.button`, `Inputs.table`.

### mutable — Imperative State

```javascript
// mutable allows imperative updates from other cells
mutable counter = 0

increment = {
  mutable counter++;
  return counter;
}
```

### Generators — Streaming Values

```javascript
// Yield successive values over time
ticker = {
  let i = 0;
  while (true) {
    yield i++;
    await Promises.delay(1000);
  }
}
```

### Block Cells

```javascript
// Use braces for multi-statement cells
result = {
  const data = await fetch("https://api.example.com/data").then(r => r.json());
  const filtered = data.filter(d => d.value > 10);
  return filtered;
}
```

## Testing

Lopecode uses a reactive testing pattern. Any cell named `test_*` is a test:

```javascript
test_addition = {
  const result = add(2, 2);
  if (result !== 4) throw new Error(`Expected 4, got ${result}`);
  return "2 + 2 = 4";  // shown on success
}

test_greeting = {
  if (typeof greeting !== "string") throw new Error("Expected string");
  return `greeting is: ${greeting}`;
}
```

Tests pass if they don't throw. Use `run_tests` to execute all `test_*` cells.

## MCP Tools Reference

| Tool | Description |
|------|-------------|
| `get_pairing_token` | Get the session pairing token |
| `reply` | Send markdown to the notebook chat |
| `define_cell` | **Primary tool.** Define a cell using Observable source code |
| `list_cells` | List cells with names, inputs, and source |
| `get_variable` | Read a runtime variable's current value |
| `define_variable` | Low-level: define a variable with a function string |
| `delete_variable` | Remove a variable |
| `list_variables` | List all named variables |
| `create_module` | Create a new empty module |
| `delete_module` | Remove a module and all its variables |
| `watch_variable` | Subscribe to reactive updates |
| `unwatch_variable` | Unsubscribe from updates |
| `run_tests` | Run all `test_*` cells |
| `eval_code` | Run ephemeral JS in the browser (not persisted) |
| `export_notebook` | Save the notebook to disk (persists cells) |
| `fork_notebook` | Create a copy as a sibling HTML file |

### Tool Usage Tips

- **`define_cell`** is the main tool for creating content. It accepts Observable source and compiles it via the toolchain.
- **`eval_code`** is for throwaway actions (DOM hacks, debugging). Effects are lost on reload.
- **`define_variable`** is a low-level escape hatch — prefer `define_cell`.
- Always specify `module` when targeting a specific module.
- Use `export_notebook` after defining cells to persist them across reloads.

## Typical Workflow

```
1. create_module("@tomlarkworthy/my-app")
2. define_cell('import {md} from "@tomlarkworthy/editable-md"', module: "...")
3. define_cell('title = md`# My App`', module: "...")
4. define_cell('viewof name = Inputs.text({label: "Name"})', module: "...")
5. define_cell('greeting = md`Hello, **${name}**!`', module: "...")
6. export_notebook()  // persist to disk
```

## Starting from a Notebook

If you see the `@tomlarkworthy/claude-code-pairing` panel in a notebook but Claude isn't connected:

1. Register with Claude: `claude mcp add lopecode -- npx -y @lopecode/channel`
2. Start Claude with `--dangerously-load-development-channels server:lopecode`, or the panel's
   chat box will accept what you type and send it nowhere ([why](#quick-start))
3. Ask Claude for a pairing token and paste it into the panel (or let Claude open the URL with `&cc=TOKEN`)

## Environment Variables

- `LOPECODE_PORT` — WebSocket server port (default: random free port)

## License

MIT
