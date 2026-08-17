# Changelog

## 0.5.0 — 2026-08-17

The release that made the published install actually work for someone who has never seen this
repo. 0.4.0 was verified at the protocol level only; a `claude -p` run against a packed tarball,
in an empty directory, now has to reach a paired notebook before anything ships.

### The npx install no longer drags playwright

`playwright` was an `optionalDependency`, so `npx -y @lopecode/channel` paid ~20MB and a browser
postinstall on every cold start, for tools it could not use until `npx playwright install
chromium` was run separately. It is a devDependency now, and the package has no runtime
dependencies at all. Installing the 0.5.0 tarball into an empty project: `added 1 package in
121ms`, `node_modules` **892K**.

The nine `qa_*` tools are consequently absent from most installs, and they are now **hidden**
rather than advertised-and-throwing:

```
tools/list, playwright resolvable    30 tools, 9 qa_*
tools/list, not resolvable           21 tools, 0 qa_*
```

Hidden, because an advertised tool that always fails gets retried. A vanilla agent called
`qa_open_notebook` three times in one run before this change; after it, zero. The old failure
message was itself the cause — it ended `npm i -g playwright … then retry`, and a global install
cannot work:

```
import "playwright" from an unrelated dir    -> ERR_MODULE_NOT_FOUND
same, with NODE_PATH at the global root      -> ERR_MODULE_NOT_FOUND
```

ESM consults neither `NODE_PATH` nor the global root. `LOPECODE_PLAYWRIGHT` points at an install
elsewhere; `none` forces the absent path, which is how the tests drive both states. `open_url`
needs no playwright, so pairing is unaffected.

### The activity feed tails your session, not the newest one

It used to scan `~/.claude/projects` for the newest `.jsonl`. Observed failure: a channel started
outside a project tailed an unrelated repo and streamed **that** repo's tool calls into the paired
notebook. The config dir was also hardcoded, so a machine setting `CLAUDE_CONFIG_DIR` always fell
through to the scan.

`resolveSessionLog()` takes the PostToolUse hook's `transcript_path` when it has one, otherwise
matches `CLAUDE_CODE_SESSION_ID` by filename across the project dirs, honouring
`CLAUDE_CONFIG_DIR`. There is no heuristic fallback — a session that cannot be named exactly is
one we do not tail. Neither half of `<config>/projects/<sanitized-cwd>/<session-id>.jsonl` is
guessable (`sanitized-cwd` is the project root, not `process.cwd()`), and both are available
exactly.

### The channel says when inbound push is dead

Notebook → Claude (the chat box, `variable_update`, `cell_change`) is a separate Claude Code
capability behind an allowlist this plugin is not on; without
`--dangerously-load-development-channels` you type into the notebook and reach nobody, silently.

The server **cannot detect** that state: `initialize` params are byte-identical with and without
the flag (`capabilities: {roots, elicitation}`, no channel marker), the `CLAUDE_*` environment is
identical, notifications are fire-and-forget, and reading the parent's argv fails under the
sandbox. So it reports a symptom instead — after forwarding a message, 40s of silence writes the
reason and the command into the notebook chat. Any tool call or hook POST cancels it, which keeps
a busy Claude from looking like a broken one. The quiet-when-active test is mutation-checked:
dropping `notePushDelivered()` from `/tool-activity` fails it.

`plugin.json` also declares its channel now (`{server, displayName}`) — nothing previously marked
this plugin as providing one. `claude plugin validate . --strict` rejects a bogus key there, so
the field is enforced rather than ignored.

### A check that the instructions work on a stranger's machine

`verify-vanilla-instructions.mjs`: packs the tarball, installs it into a temp dir, runs `claude -p
"Open a lopecode notebook"` with an empty cwd (no `CLAUDE.md`, no `.mcp.json`), `--strict-mcp-config`,
empty settings, and a PATH-shadowed headless browser stub. The verdict comes from the channel's own
`/health`, so a plausible URL that never pairs still fails.

Two harness bugs it had to be fixed for, both of which had made it pass wrongly: it asserted on the
first opener while consuming the last browser result, and its stub did not unwrap the macOS
redirect shim, which sent the agent down a path that bypassed the shim entirely. It now correlates
results per URL and requires a **portable** URL — a `file://` path to this checkout does not count
as following shipped instructions.

Credentials are what let it use a throwaway config dir (an interactive login cannot: the keychain
entry is keyed per config dir). OpenRouter serves the Anthropic Messages API directly, so
`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` needs no proxy, and CI runs it on
`xiaomi/mimo-v2.5-pro`. With no credentials it reports `config-dir-shared` rather than claiming to
be vanilla, and the CI job renders as **skipped**, not green — it had previously reported success
for a run that never happened.

It cannot attest the Local Network Access prompt: headless Chrome refuses the connection outright,
so the check disables `LocalNetworkAccessChecksWebSockets`, as `verify-https-pairing.mjs` does.

### Reproducible `dist/`

`dist/` is committed and CI rebuilds it to check it matches. A one-line mismatch inside `ws`'s
permessage-deflate turned out to be `package.json ^8.21.1` against a lockfile pinning 8.19.0 —
with the lockfile gitignored, so nothing else could see it. The lockfile is committed now and both
workflows use `npm ci`, which means the published bundle is the one CI verified. The mismatch step
prints the diff rather than only `--stat`.

### Untested

The allowlist route (`--channels plugin:lopecode-channel@lopecode-plugins` plus a root-owned
`managed-settings.json`) is read off the gate's behaviour in Claude Code 2.1.233, not run end to
end. The development flag is the path that has actually been used.

## 0.4.0

First published release. `claude mcp add lopecode -- npx -y @lopecode/channel`, the plugin
marketplace, and the MCP tool surface (`define_cell`, `run_tests`, `export_notebook`, the `qa_*`
browser tools).
