#!/usr/bin/env node
// Sits between Claude Code and the channel, forwarding stdio verbatim and appending every
// JSON-RPC frame to RPC_LOG. The channel is the thing under test, so it is not modified to
// report its own traffic; this records what the agent actually asked for.
//
//   node mcp-proxy.mjs <channel-bin> [args...]
//
// RPC_LOG   file to append {dir, msg} JSON lines to
// ERR_LOG   file to mirror the channel's stderr into
import { spawn } from "node:child_process";
import { createWriteStream, appendFileSync } from "node:fs";

const [bin, ...rest] = process.argv.slice(2);
const RPC_LOG = process.env.RPC_LOG;
const ERR_LOG = process.env.ERR_LOG;

const child = spawn(bin, rest, { stdio: ["pipe", "pipe", "pipe"] });

if (ERR_LOG) child.stderr.pipe(createWriteStream(ERR_LOG, { flags: "a" }));
else child.stderr.pipe(process.stderr);

/** Tee newline-delimited JSON, logging complete frames without buffering the stream. */
function tee(dir, from, to) {
  let buf = "";
  from.on("data", (chunk) => {
    to.write(chunk);
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line || !RPC_LOG) continue;
      try {
        appendFileSync(RPC_LOG, JSON.stringify({ dir, msg: JSON.parse(line) }) + "\n");
      } catch { /* not JSON — the transport's problem, not ours */ }
    }
  });
}

tee("to-server", process.stdin, child.stdin);
tee("to-client", child.stdout, process.stdout);

child.on("close", (code) => process.exit(code ?? 0));
