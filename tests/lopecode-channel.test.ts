/**
 * Integration tests for lopecode-channel.ts WebSocket protocol.
 *
 * Spawns the channel server as a subprocess, connects via plain WebSocket,
 * and exercises pairing, commands, notifications, and the health endpoint.
 *
 * No browser or Claude Code needed — just Bun.
 */
import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { spawn, type Subprocess } from "bun";
import path from "path";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "fs";
import { tmpdir } from "os";

const CHANNEL_SCRIPT = path.join(import.meta.dir, "../src/lopecode-channel.ts");

// --- Helpers ---

interface ServerInfo {
  proc: Subprocess;
  port: number;
  token: string;
}

/**
 * Start the channel server, parse port and token from stderr.
 * We pipe stdin so the MCP stdio transport doesn't hang on missing input.
 */
async function startServer(): Promise<ServerInfo> {
  const proc = spawn(["bun", "run", CHANNEL_SCRIPT], {
    env: { ...process.env, LOPECODE_PORT: "0" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  return new Promise<ServerInfo>((resolve, reject) => {
    const decoder = new TextDecoder();
    let stderrBuf = "";
    let resolved = false;

    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();

    function read() {
      reader.read().then(({ done, value }) => {
        if (done) {
          if (!resolved) reject(new Error(`Server exited before ready. stderr: ${stderrBuf}`));
          return;
        }
        stderrBuf += decoder.decode(value);
        const tokenMatch = stderrBuf.match(/pairing token: (LOPE-\d+-\w+)/);
        const portMatch = stderrBuf.match(/WebSocket server on ws:\/\/127\.0\.0\.1:(\d+)/);
        if (tokenMatch && portMatch && !resolved) {
          resolved = true;
          resolve({ proc, token: tokenMatch[1], port: Number(portMatch[1]) });
        } else {
          read();
        }
      });
    }
    read();

    setTimeout(() => {
      if (!resolved) {
        proc.kill();
        reject(new Error(`Server did not start in time. stderr: ${stderrBuf}`));
      }
    }, 10000);
  });
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error(`WebSocket error: ${e}`));
    setTimeout(() => reject(new Error("WebSocket connect timeout")), 5000);
  });
}

function sendAndReceive(ws: WebSocket, msg: unknown, timeout = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Response timeout")), timeout);
    const handler = (event: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      resolve(JSON.parse(event.data));
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify(msg));
  });
}

// --- Tests ---

describe("lopecode-channel server", () => {
  let proc: Subprocess;
  let port: number;
  let token: string;

  beforeAll(async () => {
    ({ proc, port, token } = await startServer());
  });

  afterAll(() => {
    proc?.kill();
  });

  describe("health endpoint", () => {
    it("returns health status", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.paired).toBe(0);
      expect(typeof body.pending).toBe("number");
    });
  });

  describe("pairing", () => {
    it("rejects invalid token", async () => {
      const ws = await connectWs(port);
      const response = await sendAndReceive(ws, {
        type: "pair",
        token: "LOPE-0000-FAKE",
        url: "http://test/bad",
        title: "Bad",
      });
      expect(response.type).toBe("pair-failed");
      expect(response.reason).toContain("Invalid");
    });

    it("accepts valid token and returns paired", async () => {
      const ws = await connectWs(port);
      const response = await sendAndReceive(ws, {
        type: "pair",
        token,
        url: "http://test/notebook1",
        title: "Test Notebook",
      });
      expect(response.type).toBe("paired");
      expect(response.notebook_id).toBe("http://test/notebook1");
      ws.close();
    });

    it("shows paired count on health after pairing", async () => {
      const ws = await connectWs(port);
      await sendAndReceive(ws, {
        type: "pair",
        token,
        url: "http://test/notebook-health",
        title: "Health Test",
      });

      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await res.json() as any;
      expect(body.paired).toBeGreaterThanOrEqual(1);
      ws.close();
    });
  });

  describe("token format", () => {
    it("follows LOPE-PORT-XXXX format", () => {
      const match = token.match(/^LOPE-(\d+)-([A-Z2-9]{4})$/);
      expect(match).toBeTruthy();
      expect(Number(match![1])).toBe(port);
    });
  });

  describe("command protocol", () => {
    it("receives commands after pairing", async () => {
      const ws = await connectWs(port);
      await sendAndReceive(ws, {
        type: "pair",
        token,
        url: "http://test/notebook-cmd",
        title: "Cmd Test",
      });

      // Verify that sending a command-result doesn't crash the server
      ws.send(JSON.stringify({
        type: "command-result",
        id: "cmd-fake-123",
        ok: true,
        result: "hello",
      }));

      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      ws.close();
    });

    it("receives reply messages", async () => {
      const ws = await connectWs(port);
      await sendAndReceive(ws, {
        type: "pair",
        token,
        url: "http://test/notebook-reply",
        title: "Reply Test",
      });

      ws.send(JSON.stringify({
        type: "message",
        content: "Hello from test",
      }));

      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      ws.close();
    });
  });

  describe("variable-update forwarding", () => {
    it("accepts variable-update messages without error", async () => {
      const ws = await connectWs(port);
      await sendAndReceive(ws, {
        type: "pair",
        token,
        url: "http://test/notebook-var",
        title: "Var Test",
      });

      ws.send(JSON.stringify({
        type: "variable-update",
        name: "testVar",
        module: "@test/mod",
        value: "42",
      }));

      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      ws.close();
    });
  });

  describe("cell-change forwarding", () => {
    it("accepts cell-change messages", async () => {
      const ws = await connectWs(port);
      await sendAndReceive(ws, {
        type: "pair",
        token,
        url: "http://test/notebook-cell",
        title: "Cell Test",
      });

      ws.send(JSON.stringify({
        type: "cell-change",
        changes: [
          {
            module: "@test/mod",
            _name: "myCell",
            _definition: "() => 42",
            op: "upd",
          },
        ],
      }));

      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      ws.close();
    });
  });

  describe("disconnection", () => {
    it("removes notebook from paired on close", async () => {
      const ws = await connectWs(port);
      await sendAndReceive(ws, {
        type: "pair",
        token,
        url: "http://test/notebook-disconnect",
        title: "Disconnect Test",
      });

      let res = await fetch(`http://127.0.0.1:${port}/health`);
      let body = await res.json() as any;
      const pairedBefore = body.paired;

      ws.close();
      await new Promise((r) => setTimeout(r, 200));

      res = await fetch(`http://127.0.0.1:${port}/health`);
      body = await res.json();
      expect(body.paired).toBeLessThan(pairedBefore);
    });
  });

  describe("notebook-info", () => {
    it("accepts notebook-info messages", async () => {
      const ws = await connectWs(port);
      await sendAndReceive(ws, {
        type: "pair",
        token,
        url: "http://test/notebook-info",
        title: "Info Test",
      });

      ws.send(JSON.stringify({
        type: "notebook-info",
        modules: ["@test/mod1", "@test/mod2"],
        title: "Updated Title",
      }));

      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      ws.close();
    });
  });
});

/**
 * playwright is not a dependency, so most installs cannot run the qa_* tools. Advertising them
 * anyway taught an agent to retry one three times in a row (seen in CI against MiMo), so they
 * are hidden when playwright cannot be resolved.
 */
describe("qa_* tools are only advertised when playwright is available", () => {
  /** Minimal MCP stdio client: initialize, then tools/list. */
  async function listTools(env: Record<string, string>): Promise<{ names: string[]; instructions: string }> {
    const proc = spawn(["bun", "run", CHANNEL_SCRIPT], {
      env: { ...process.env as any, LOPECODE_PORT: "0", ...env },
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
    });
    const send = (o: unknown) => proc.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });

    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let instructions = "";
    try {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            instructions = msg.result?.instructions ?? "";
            send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
          }
          if (msg.id === 2) return { names: msg.result.tools.map((t: any) => t.name), instructions };
        }
      }
      throw new Error("no tools/list response");
    } finally {
      reader.releaseLock();
      proc.kill();
    }
  }

  it("lists them when playwright resolves", async () => {
    const { names } = await listTools({});
    expect(names.filter((n) => n.startsWith("qa_")).length).toBeGreaterThan(0);
  });

  it("hides them, and says why, when it does not", async () => {
    const { names, instructions } = await listTools({ LOPECODE_PLAYWRIGHT: "none" });
    expect(names.filter((n) => n.startsWith("qa_"))).toEqual([]);
    expect(names).toContain("open_url");            // the alternative must still be there
    expect(instructions.replace(/\s+/g, " ")).toContain("are NOT available in this session");
    // A global install is what an agent reaches for first, and ESM cannot resolve it —
    // the advice has to say so rather than leaving it as the obvious next step.
    expect(instructions.replace(/\s+/g, " ")).toContain("`npm i -g playwright` does NOT work");
  });
});

/**
 * Inbound push is allowlist-gated in Claude Code and the server cannot see that decision —
 * initialize capabilities and CLAUDE_* env are identical with and without --channels. So the
 * channel watches for a symptom instead: a forwarded message that nothing answers.
 */
describe("inbound push liveness", () => {
  it("warns into the notebook chat when a forwarded message goes unanswered", async () => {
    const proc = spawn(["bun", "run", CHANNEL_SCRIPT], {
      // Short timeout so the test does not wait the production 40s.
      env: { ...process.env as any, LOPECODE_PORT: "0", LOPECODE_PUSH_SILENCE_MS: "300" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    try {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (!/WebSocket server on/.test(buf)) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
      }
      reader.releaseLock();
      const port = Number(buf.match(/WebSocket server on ws:\/\/127\.0\.0\.1:(\d+)/)![1]);
      const tok = buf.match(/pairing token: (LOPE-\d+-\w+)/)![1];

      const ws = await connectWs(port);
      await sendAndReceive(ws, { type: "pair", token: tok, url: "http://test/push", title: "Push" });

      const warning = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no warning arrived")), 5000);
        ws.addEventListener("message", (e: MessageEvent) => {
          const m = JSON.parse(e.data);
          if (m.type === "reply") { clearTimeout(timer); resolve(m); }
        });
      });
      ws.send(JSON.stringify({ type: "message", content: "anyone there?" }));

      const m = await warning;
      expect(m.markdown).toContain("did not reach Claude");
      expect(m.markdown).toContain("--dangerously-load-development-channels server:lopecode");
      ws.close();
    } finally {
      proc.kill();
    }
  });

  it("stays quiet when Claude is demonstrably active", async () => {
    const proc = spawn(["bun", "run", CHANNEL_SCRIPT], {
      env: { ...process.env as any, LOPECODE_PORT: "0", LOPECODE_PUSH_SILENCE_MS: "300" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    try {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (!/WebSocket server on/.test(buf)) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
      }
      reader.releaseLock();
      const port = Number(buf.match(/WebSocket server on ws:\/\/127\.0\.0\.1:(\d+)/)![1]);
      const tok = buf.match(/pairing token: (LOPE-\d+-\w+)/)![1];

      const ws = await connectWs(port);
      await sendAndReceive(ws, { type: "pair", token: tok, url: "http://test/push-ok", title: "PushOK" });

      let warned = false;
      ws.addEventListener("message", (e: MessageEvent) => {
        if (JSON.parse(e.data).type === "reply") warned = true;
      });
      ws.send(JSON.stringify({ type: "message", content: "anyone there?" }));

      // A PostToolUse hook POST is proof Claude is working, so the probe must stand down.
      await fetch(`http://127.0.0.1:${port}/tool-activity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } }),
      });

      await new Promise((r) => setTimeout(r, 1200));   // 4x the silence window
      expect(warned).toBe(false);
      ws.close();
    } finally {
      proc.kill();
    }
  });
});

/**
 * The activity feed tails this session's transcript. It used to find it by scanning
 * ~/.claude/projects for the newest .jsonl, which tails whichever project was touched
 * most recently — someone else's session — whenever the channel runs outside a project
 * or under a CLAUDE_CONFIG_DIR that is not ~/.claude.
 */
describe("session log resolution", () => {
  let configDir: string;
  let ownLog: string;
  const SESSION_ID = "11111111-2222-3333-4444-555555555555";

  beforeAll(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "lope-cfg-"));
    // Our session's transcript, deliberately the OLDER file.
    const mine = path.join(configDir, "projects", "-home-me-my-project");
    mkdirSync(mine, { recursive: true });
    ownLog = path.join(mine, `${SESSION_ID}.jsonl`);
    writeFileSync(ownLog, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(ownLog, old, old);
    // An unrelated project, touched more recently — the old heuristic's winner.
    const other = path.join(configDir, "projects", "-home-me-someone-elses-project");
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, "99999999-aaaa-bbbb-cccc-dddddddddddd.jsonl"), "");
  });

  afterAll(() => rmSync(configDir, { recursive: true, force: true }));

  /** Start a server with a scrubbed environment and return its startup stderr. */
  async function startupStderr(extraEnv: Record<string, string>): Promise<{ proc: Subprocess; stderr: string; port: number }> {
    const env: Record<string, string> = { ...process.env as any, LOPECODE_PORT: "0", CLAUDE_CONFIG_DIR: configDir, ...extraEnv };
    // The test runner is itself a Claude Code child; its session must not leak in.
    if (!("CLAUDE_CODE_SESSION_ID" in extraEnv)) delete env.CLAUDE_CODE_SESSION_ID;

    const proc = spawn(["bun", "run", CHANNEL_SCRIPT], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      // The tail line is written last, after the port line.
      if (/session log tailing started|session not identified/.test(buf)) break;
    }
    reader.releaseLock();
    const port = Number(buf.match(/WebSocket server on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
    return { proc, stderr: buf, port };
  }

  it("tails the session named by CLAUDE_CODE_SESSION_ID, not the newest transcript", async () => {
    const { proc, stderr } = await startupStderr({ CLAUDE_CODE_SESSION_ID: SESSION_ID });
    try {
      expect(stderr).toContain(`session log tailing started (${SESSION_ID}.jsonl)`);
      expect(stderr).not.toContain("99999999-aaaa-bbbb-cccc-dddddddddddd");
    } finally {
      proc.kill();
    }
  });

  it("tails nothing when the session cannot be identified", async () => {
    const { proc, stderr } = await startupStderr({});
    try {
      expect(stderr).toContain("session not identified yet");
      expect(stderr).not.toContain("99999999-aaaa-bbbb-cccc-dddddddddddd");
    } finally {
      proc.kill();
    }
  });

  it("adopts the transcript_path the PostToolUse hook reports", async () => {
    const { proc, stderr, port } = await startupStderr({});
    try {
      expect(stderr).toContain("session not identified yet");
      const res = await fetch(`http://127.0.0.1:${port}/tool-activity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: SESSION_ID,
          transcript_path: ownLog,
          tool_name: "Bash",
          tool_input: { command: "echo hi" },
        }),
      });
      expect(res.status).toBe(200);

      // The tailer re-resolves on its 500ms poll.
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !buf.includes(`${SESSION_ID}.jsonl`)) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
      }
      reader.releaseLock();
      expect(buf).toContain(`tailing session log ${SESSION_ID}.jsonl`);
    } finally {
      proc.kill();
    }
  });
});
