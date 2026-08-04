#!/usr/bin/env node
// The user story: a notebook served from a domain the user does not own pairs with a
// channel server installed locally via `npx` (no Bun, no plugin, no relay).
import { spawn } from "child_process";

const ENTRY = process.argv[2] ?? "dist/lopecode-channel.mjs";
const BASE = "https://tomlarkworthy.github.io/lopecode/notebooks/";
// Both names host the same two modules; the rename ships whenever the content repo is pushed,
// so resolve rather than pin — a 404 here must fail loudly, not as a pairing timeout.
const CANDIDATES = ["quick_start.html", "@tomlarkworthy_blank-notebook.html"];
const LAYOUT = "#view=R100(S60(@tomlarkworthy/blank-notebook),S40(@tomlarkworthy/claude-code-pairing))";

const resolveNotebook = async () => {
  const tried = [];
  for (const name of CANDIDATES) {
    const url = BASE + name;
    const status = await fetch(url, { method: "HEAD" }).then((r) => r.status).catch((e) => e.message);
    if (status === 200) return url;
    tried.push(`${name} → ${status}`);
  }
  throw new Error(`no notebook served: ${tried.join(", ")}`);
};

const proc = ENTRY.endsWith(".mjs")
  ? spawn("node", [ENTRY], { cwd: import.meta.dirname, stdio: ["pipe", "pipe", "pipe"] })
  : spawn(ENTRY, [], { cwd: import.meta.dirname, stdio: ["pipe", "pipe", "pipe"] });

let stderr = "", token = null, port = null;
proc.stderr.on("data", (d) => {
  stderr += d.toString();
  token ??= stderr.match(/pairing token: (LOPE-\d+-[A-Z0-9]+)/)?.[1] ?? null;
  port ??= Number(stderr.match(/ws:\/\/127\.0\.0\.1:(\d+)\/ws/)?.[1]) || null;
});
proc.stdout.on("data", () => {});

const until = async (pred, ms, what) => {
  const t0 = Date.now();
  for (;;) {
    const hit = await pred();
    if (hit) return hit;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};

let browser;
try {
  // MCP handshake so the server finishes booting.
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify", version: "0" } } }) + "\n");
  await until(() => token && port, 20000, "token+port");
  console.log(`channel server up on ${port}, token ${token}`);

  const notebook = await resolveNotebook();
  console.log(`serving: ${notebook}`);

  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const url = `${notebook}${LAYOUT}&cc=${token}`;
  console.log(`opening ${url.slice(0, 96)}…`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  const health = await until(async () => {
    const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null);
    return h?.paired > 0 ? h : null;
  }, 90000, "notebook to pair");

  console.log("PAIRED from an https origin:", JSON.stringify(health));
  const origin = await page.evaluate(() => location.origin);
  console.log("notebook origin:", origin);
  const status = await page.evaluate(() => window.__ojs_runtime ? "runtime up" : "no runtime");
  console.log("page:", status);
  console.log("\nPASS — https-origin notebook paired to a local npx-installed channel");
} catch (e) {
  console.error("FAIL:", e.message);
  console.error("server stderr:\n" + stderr);
  process.exitCode = 1;
} finally {
  await browser?.close();
  proc.kill();
}
