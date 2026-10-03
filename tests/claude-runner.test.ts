/**
 * The LLM runner mounted on the channel port (LOPECODE_LLM_RUNNER=1).
 *
 * The gating tests need no model. The live test spends Claude subscription usage and runs only
 * with LOPECODE_LLM_LIVE=1.
 */
import { describe, it, afterAll, expect } from "bun:test";
import { spawn, type Subprocess } from "bun";
import path from "path";

const CHANNEL_SCRIPT = path.join(import.meta.dir, "../src/lopecode-channel.ts");
const procs: Subprocess[] = [];

async function startServer(env: Record<string, string>): Promise<{ port: number; token: string }> {
  const proc = spawn(["bun", "run", CHANNEL_SCRIPT], {
    env: { ...process.env, LOPECODE_PORT: "0", LOPECODE_PORT_FILE: path.join(import.meta.dir, ".runner-test-port"), ...env },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  procs.push(proc);
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
    const token = buf.match(/pairing token: (LOPE-\d+-\w+)/);
    const port = buf.match(/WebSocket server on ws:\/\/127\.0\.0\.1:(\d+)/);
    if (token && port) {
      (async () => { for (;;) { const r = await reader.read(); if (r.done) break; } })();   // keep draining
      return { token: token[1], port: Number(port[1]) };
    }
  }
  throw new Error("server did not start: " + buf);
}

afterAll(() => { for (const p of procs) p.kill(); });

describe("LLM runner off (default)", () => {
  it("refuses /v1 with a readable, CORS-visible reason", async () => {
    const { port } = await startServer({ LOPECODE_LLM_RUNNER: "" });
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect((await res.json()).error.message).toContain("LOPECODE_LLM_RUNNER=1");
    expect((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).llm).toBeNull();
  });
});

describe("LLM runner on", () => {
  let port: number, token: string;
  const ready = startServer({ LOPECODE_LLM_RUNNER: "1" }).then((s) => ({ port, token } = s));

  it("lists models without a token, with CORS", async () => {
    await ready;
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const ids = (await res.json()).data.map((m: any) => m.id);
    expect(ids).toContain("claude-sonnet-5-5");
  });

  it("answers the preflight", async () => {
    await ready;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toBe("*");
  });

  it("refuses a chat without the pairing token", async () => {
    await ready;
    const post = (auth?: string) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect((await post()).status).toBe(401);
    expect((await post("Bearer LOPE-0-NOPE")).status).toBe(401);
  });

  it("reports runner stats on /health and leaves the other routes alone", async () => {
    await ready;
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(health.llm).toEqual({ requests: 0, continued: 0, started: 0, rebuilt: 0, interrupts: 0 });
    expect(health.paired).toBe(0);
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
  });

  it.skipIf(process.env.LOPECODE_LLM_LIVE !== "1")("returns the caller's tool as tool_calls, then continues on its result", async () => {
    await ready;
    const tools = [{ type: "function", function: { name: "calc", description: "Evaluate arithmetic", parameters: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] } } }];
    const messages: any[] = [{ role: "system", content: "You are terse. Always use the calc tool for arithmetic." }, { role: "user", content: "What is 17*3?" }];
    const chat = async () => (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ model: "claude-haiku-4-5", stream: false, messages, tools }),
    })).json();
    const first = await chat();
    expect(first.choices[0].finish_reason).toBe("tool_calls");
    const call = first.choices[0].message.tool_calls[0];
    expect(call.function.name).toBe("calc");
    messages.push(first.choices[0].message, { role: "tool", tool_call_id: call.id, content: "51" });
    const second = await chat();
    expect(second.choices[0].message.content).toContain("51");
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(health.llm).toMatchObject({ started: 1, continued: 1, rebuilt: 0 });
  }, 60000);
});
