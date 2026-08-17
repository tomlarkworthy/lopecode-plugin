#!/usr/bin/env node
/**
 * Can a Claude Code that has never seen this project follow the shipped instructions?
 *
 * Everything else in this repo tests the channel's protocol. This tests its *instructions* —
 * the `instructions` block in src/lopecode-channel.ts and the tool descriptions — which are
 * the only guidance a stranger gets. They are prose, so nothing else can catch it when they
 * tell the agent to open a file that exists on the author's machine and nowhere else.
 *
 * The run is deliberately impoverished:
 *   - cwd is an empty temp dir, so no CLAUDE.md and no .mcp.json apply
 *   - --strict-mcp-config, so only the channel we install is reachable
 *   - --settings with an empty object, so no hooks or plugins load
 *   - the channel is installed from `npm pack`, the way a user gets it
 *   - `open`/`xdg-open` are shadowed on PATH by a Playwright stub, so no window appears
 *
 * Verdict comes from the channel, not from reading the agent's prose: the stub loads whatever
 * URL the agent asked for and reports /health. paired > 0 means the instructions worked.
 *
 *   node verify-vanilla-instructions.mjs [--keep] [--prompt "..."]
 *
 * Credentials decide how vanilla the run can be, and the mode is printed rather than assumed:
 *
 *   ANTHROPIC_API_KEY                            → fully-isolated, real Claude
 *   ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN    → fully-isolated, whatever that endpoint serves
 *   neither                                      → config-dir-shared, a weaker claim
 *
 * OpenRouter serves the Anthropic Messages API at https://openrouter.ai/api, so an OpenRouter
 * key runs this with no Anthropic key and no proxy:
 *
 *   ANTHROPIC_BASE_URL=https://openrouter.ai/api ANTHROPIC_AUTH_TOKEN=$OPENROUTER_API_KEY \
 *   ANTHROPIC_MODEL=xiaomi/mimo-v2.5-pro node verify-vanilla-instructions.mjs
 *
 * Two things that buys, and one it does not. It buys a genuinely empty config dir (an
 * interactive login cannot: the keychain entry is keyed per config dir), and it buys a harder
 * test — instructions a non-Claude model can follow are instructions that do not lean on the
 * reader. It does not buy coverage of inbound push: the channel gate's first branch is
 * `if (Jn() !== "firstParty") … "channels are not available on third-party providers"`, so a
 * custom endpoint can never exercise the notebook → Claude direction.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const PROMPT = args.includes("--prompt") ? args[args.indexOf("--prompt") + 1] : "Open a lopecode notebook";

const root = mkdtempSync(join(tmpdir(), "lope-vanilla-"));
const ws = join(root, "workspace");          // empty cwd: no CLAUDE.md, no .mcp.json
const bin = join(root, "bin");               // PATH shim for the browser
const pkg = join(root, "pkg");               // where the packed tarball gets installed
for (const d of [ws, bin, pkg]) mkdirSync(d, { recursive: true });

const RPC_LOG = join(root, "rpc.jsonl");
const ERR_LOG = join(root, "channel-stderr.log");
const BROWSER_RESULT = join(root, "browser-result.json");
writeFileSync(RPC_LOG, "");
writeFileSync(ERR_LOG, "");

const fail = [];
const note = (s) => console.log(s);

function cleanup() {
  if (KEEP) console.log(`\nartifacts kept in ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

// --- install the channel the way the README says a user does ---------------------------------
note("installing @lopecode/channel from a packed tarball…");
const tgz = execFileSync("npm", ["pack", "--silent", "--pack-destination", root], { cwd: HERE })
  .toString().trim().split("\n").pop();
execFileSync("npm", ["init", "-y"], { cwd: pkg, stdio: "ignore" });
execFileSync("npm", ["install", "--no-audit", "--no-fund", join(root, tgz)], { cwd: pkg, stdio: "ignore" });
const channelBin = join(pkg, "node_modules", ".bin", "lopecode-channel");
if (!existsSync(channelBin)) { console.error(`FAIL: packed tarball exposes no lopecode-channel bin`); cleanup(); process.exit(1); }

// --- shadow the browser launcher -------------------------------------------------------------
for (const name of ["open", "xdg-open"]) {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${join(HERE, "tests/vanilla/stub-browser.mjs")}" "$@"\n`);
  chmodSync(p, 0o755);
}

// --- the only MCP server this session can see ------------------------------------------------
const mcpCfg = join(root, "mcp.json");
writeFileSync(mcpCfg, JSON.stringify({
  mcpServers: {
    lopecode: {
      command: process.execPath,
      args: [join(HERE, "tests/vanilla/mcp-proxy.mjs"), channelBin],
      env: { RPC_LOG, ERR_LOG, BROWSER_RESULT, PATH: `${bin}:${process.env.PATH}` },
    },
  },
}, null, 2));

const settings = join(root, "settings.json");
writeFileSync(settings, "{}");

// --- credentials decide how vanilla we can be -----------------------------------------------
//
// Anything that authenticates by env var can also run against a throwaway config dir, which is
// what makes a fully vanilla profile possible: an interactive login cannot, because the keychain
// entry is keyed per config dir (Claude Code-credentials-<hash>), so a fresh dir has no
// credentials and `claude -p` reports "Not logged in".
//
// ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN covers any Anthropic-Messages-compatible endpoint.
// OpenRouter serves one at https://openrouter.ai/api, so an OpenRouter key drives this check
// with no Anthropic key and no translating proxy.
const byApiKey = !!process.env.ANTHROPIC_API_KEY;
const byToken = !!(process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_AUTH_TOKEN);
const isolatable = byApiKey || byToken;
const cfgDir = join(root, "config");
if (isolatable) mkdirSync(cfgDir, { recursive: true });
const mode = isolatable ? "fully-isolated" : "config-dir-shared";
const provider = byToken ? (process.env.ANTHROPIC_BASE_URL ?? "custom") : "anthropic";
const model = process.env.ANTHROPIC_MODEL ?? "(Claude Code default)";

const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RPC_LOG, ERR_LOG, BROWSER_RESULT };
// A session's own identity must not leak into the child, or it tails our transcript and
// resolves our project rather than starting clean.
for (const k of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_PROJECT_DIR", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_EFFORT", "CLAUDE_PID"]) delete env[k];
if (isolatable) env.CLAUDE_CONFIG_DIR = cfgDir;
// Background work (session titles and the like) otherwise reaches for a Claude model the
// custom endpoint may not serve.
if (byToken && process.env.ANTHROPIC_MODEL && !process.env.ANTHROPIC_SMALL_FAST_MODEL) {
  env.ANTHROPIC_SMALL_FAST_MODEL = process.env.ANTHROPIC_MODEL;
}

// Structural proof of what was actually isolated, rather than a claim that it was.
const isolation = {
  cwd: ws,
  cwdHasClaudeMd: existsSync(join(ws, "CLAUDE.md")),
  cwdHasMcpJson: existsSync(join(ws, ".mcp.json")),
  configDir: isolatable ? cfgDir : (process.env.CLAUDE_CONFIG_DIR ?? "~/.claude"),
  configDirHasClaudeMd: existsSync(join(isolatable ? cfgDir : (process.env.CLAUDE_CONFIG_DIR ?? ""), "CLAUDE.md")),
  mode, provider, model,
};
if (isolation.cwdHasClaudeMd || isolation.cwdHasMcpJson) fail.push("workspace was not clean");
if (isolation.configDirHasClaudeMd) fail.push(`a user-level CLAUDE.md at ${isolation.configDir} still applies — this run is not vanilla`);

note(`mode: ${mode}   provider: ${provider}   model: ${model}`);
if (!isolatable) note("  (set ANTHROPIC_API_KEY, or ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN, to isolate the config dir too)");
note(`prompt: ${JSON.stringify(PROMPT)}`);
note("running claude…");

const run = spawnSync("claude", [
  "-p", PROMPT,
  "--strict-mcp-config", "--mcp-config", mcpCfg,
  "--settings", settings,
  "--dangerously-skip-permissions",
], { cwd: ws, env, encoding: "utf8", timeout: 300000, stdio: ["ignore", "pipe", "pipe"] });

const transcript = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
appendFileSync(join(root, "claude-output.txt"), transcript);
if (/Not logged in|Please run \/login|Invalid API key/.test(transcript)) {
  console.error(`\nSKIP: no usable credentials in ${mode} mode.\n${transcript.trim().slice(0, 300)}`);
  cleanup();
  process.exit(2);
}

// --- what did the agent actually do? --------------------------------------------------------
const frames = readFileSync(RPC_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const calls = frames
  .filter((f) => f.dir === "to-server" && f.msg.method === "tools/call")
  .map((f) => ({ name: f.msg.params?.name, args: f.msg.params?.arguments ?? {} }));

note(`\ntools called: ${calls.length ? calls.map((c) => c.name).join(", ") : "(none)"}`);

if (!calls.length) fail.push("the agent called no channel tools at all — the instructions did not lead it to the channel");
if (!calls.some((c) => c.name === "get_pairing_token")) fail.push("never called get_pairing_token");

const openers = calls.filter((c) => ["open_url", "qa_open_notebook"].includes(c.name));
if (!openers.length) fail.push("never tried to open a notebook (no open_url / qa_open_notebook)");

// Every invocation of the stub, in order. Correlated to openers by URL rather than by position:
// the agent may open more than one, and a result for URL A says nothing about URL B.
const browserResults = existsSync(BROWSER_RESULT)
  ? readFileSync(BROWSER_RESULT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const pairedUrls = new Set(browserResults.filter((r) => r.ok).map((r) => r.url));

/**
 * Would a stranger have this?
 *
 * An http(s) notebook is portable. A file:// path inside the throwaway workspace is portable
 * (the agent made it). A file:// path anywhere else is a notebook that happens to exist on THIS
 * machine — which is the failure this check exists to find, and the reason a shared config dir
 * cannot be trusted to produce an honest verdict on its own: the agent can go looking for the
 * author's checkout and find it.
 */
async function classify(target) {
  if (/^https?:/.test(target)) {
    const res = await fetch(target, { method: "HEAD" }).catch((e) => ({ ok: false, status: e.message }));
    return res.ok ? { portable: true } : { portable: false, why: `not reachable (${res.status})` };
  }
  if (target.startsWith("file://")) {
    const p = fileURLToPath(target);
    if (p.startsWith(root)) return { portable: true };
    return {
      portable: false,
      why: existsSync(p)
        ? `a local notebook that exists only on this machine — a stranger has no ${p}`
        : `a local notebook that does not exist even here: ${p}`,
    };
  }
  return { portable: false, why: "unrecognised notebook target" };
}

let portablePaired = false;
const reported = new Set();   // an agent may open the same URL repeatedly; say so once
for (const o of openers) {
  const url = String(o.args.url ?? "");
  const target = url.split("#")[0];
  const cls = await classify(target);
  const paired = pairedUrls.has(url);
  if (!reported.has(url)) {
    reported.add(url);
    note(`opened ${cls.portable ? "portable" : "MACHINE-LOCAL"}${paired ? ", paired" : ", did not pair"}: ${url}`);
    if (!/cc=LOPE-\d+-/.test(url)) fail.push(`URL carries no pairing token: ${url}`);
    if (!url.includes("#")) fail.push(`URL carries no hash layout: ${url}`);
    if (!cls.portable) fail.push(`the instructions sent the agent to ${cls.why}`);
  }
  if (cls.portable && paired) portablePaired = true;
}

for (const r of browserResults) if (!r.ok) note(`  browser: ${r.why ?? JSON.stringify(r.health)}`);
if (openers.length && !browserResults.length) fail.push("the browser stub was never invoked, so nothing loaded any URL");
if (openers.length && !portablePaired) {
  // Two very different faults land here, so name which one it was.
  const anyPortable = browserResults.some((r) => r.url && /^https?:/.test(r.url));
  fail.push(anyPortable
    ? `a portable URL was opened but never paired: ${browserResults.map((r) => r.why ?? JSON.stringify(r.health)).join("; ")}`
    : "no portable notebook URL ever paired — reaching a notebook depended on files only this machine has");
}

writeFileSync(join(root, "verdict.json"), JSON.stringify({ mode, provider, model, isolation, calls, browserResults, fail }, null, 2));

if (fail.length) {
  console.error(`\nFAIL — the shipped instructions are not usable as-is:`);
  for (const f of fail) console.error(`  · ${f}`);
  console.error(`\nchannel stderr:\n${readFileSync(ERR_LOG, "utf8").trim().slice(-1200)}`);
  console.error(`\nagent output:\n${transcript.trim().slice(-1200)}`);
  if (!KEEP) console.error(`\n(re-run with --keep to inspect ${root})`);
  cleanup();
  process.exit(1);
}

note(`\nPASS — a vanilla Claude Code followed the shipped instructions to a paired notebook (${mode}, ${model})`);
cleanup();
