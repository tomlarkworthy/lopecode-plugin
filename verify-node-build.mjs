#!/usr/bin/env node
// End-to-end check of the Node bundle: MCP stdio handshake + tool list, then a
// real WebSocket pair against the port the server reports.
import { spawn } from "child_process";
import { WebSocket } from "ws";

// Defaults to the Node bundle; pass a command to check another entry point
// (e.g. `node verify-node-build.mjs bun lopecode-channel.ts`).
const argv = process.argv.slice(2);
const [cmd, ...args] = argv.length ? argv : ["node", "dist/lopecode-channel.mjs"];
console.log(`--- verifying: ${cmd} ${args.join(" ")}`);
const proc = spawn(cmd, args, { cwd: import.meta.dirname, stdio: ["pipe", "pipe", "pipe"] });

let token = null, port = null, stderr = "";
proc.stderr.on("data", (d) => {
  stderr += d.toString();
  const t = stderr.match(/pairing token: (LOPE-\d+-[A-Z0-9]+)/);
  if (t) token = t[1];
  const p = stderr.match(/ws:\/\/127\.0\.0\.1:(\d+)\/ws/);
  if (p) port = Number(p[1]);
});

const replies = [];
let buf = "";
proc.stdout.on("data", (d) => {
  buf += d.toString();
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const l of lines) if (l.trim()) replies.push(JSON.parse(l));
});

const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
const waitFor = (pred, ms, what) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const hit = pred();
    if (hit) { clearInterval(iv); res(hit); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout: ${what}\nstderr:\n${stderr}`)); }
  }, 50);
});

const fail = (m) => { console.error("FAIL:", m); proc.kill(); process.exit(1); };

try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify", version: "0" } } });
  const init = await waitFor(() => replies.find((r) => r.id === 1), 15000, "initialize");
  const caps = init.result?.capabilities ?? {};
  console.log("initialize ok — server:", init.result?.serverInfo?.name, "| channel cap:", JSON.stringify(caps.experimental ?? {}));

  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const list = await waitFor(() => replies.find((r) => r.id === 2), 15000, "tools/list");
  const names = list.result.tools.map((t) => t.name);
  console.log(`tools/list ok — ${names.length} tools (${names.slice(0, 4).join(", ")}, …)`);
  if (!names.includes("get_pairing_token")) fail("get_pairing_token missing");

  await waitFor(() => token && port, 15000, "token+port on stderr");
  console.log(`server listening on ${port}, token ${token}`);

  // Health endpoint (node http path)
  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  console.log("health ok —", JSON.stringify(health));

  // Real pairing handshake over the ws:// path
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const got = [];
  ws.on("message", (d) => got.push(JSON.parse(d.toString())));
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  ws.send(JSON.stringify({ type: "pair", token, url: "file:///verify.html", title: "verify", tools: [] }));
  const paired = await waitFor(() => got.find((m) => m.type === "paired"), 10000, "paired message");
  console.log("websocket pair ok —", JSON.stringify(paired));

  const health2 = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  if (health2.paired !== 1) fail(`expected paired:1, got ${JSON.stringify(health2)}`);
  console.log("health reflects pairing —", JSON.stringify(health2));

  // A tool call that round-trips through the websocket to the "notebook".
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_pairing_token", arguments: {} } });
  const tokRes = await waitFor(() => replies.find((r) => r.id === 3), 10000, "get_pairing_token call");
  console.log("tools/call ok —", tokRes.result.content[0].text.slice(0, 80));

  ws.close();
  console.log("\nALL CHECKS PASSED");
  proc.kill();
  process.exit(0);
} catch (e) {
  fail(e.message);
}
