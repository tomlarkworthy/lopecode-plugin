#!/usr/bin/env bun
// claude-runner on its own port, without a Claude Code session or a paired notebook.
//
//   bun src/claude-runner-cli.ts [--port 8765] [--token T] [--model claude-sonnet-5-5] [--cwd DIR] [--verbose]
import { randomBytes } from "node:crypto";
import http from "node:http";
import { createClaudeRunner, MODELS } from "./claude-runner.ts";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const port = Number(arg("port", process.env.RC5_RUNNER_PORT || "8765"));
const token = arg("token", process.env.RC5_RUNNER_TOKEN) || randomBytes(12).toString("hex");
const defaultModel = arg("model", process.env.RC5_RUNNER_MODEL);

const runner = createClaudeRunner({
  token: () => token,
  defaultModel,
  cwd: arg("cwd"),
  verbose: process.argv.includes("--verbose"),
  log: (...a) => console.log(...a),
});
const server = http.createServer((req, res) => {
  if (runner.handle(req, res)) return;
  if (req.url === "/health") {
    res.writeHead(200, { ...runner.cors, "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, llm: { enabled: true }, ...runner.status() }));
    return;
  }
  res.writeHead(404).end("not found");
});
server.listen(port, "127.0.0.1", () => {
  console.log(`claude-runner listening`);
  console.log(`  base URL: http://127.0.0.1:${port}/v1`);
  console.log(`  token:    ${token}`);
  console.log(`  models:   ${MODELS.join(", ")}${defaultModel ? ` (other ids → ${defaultModel})` : " (other ids → the CLI default)"}`);
});
process.on("SIGINT", () => { runner.close(); process.exit(0); });
