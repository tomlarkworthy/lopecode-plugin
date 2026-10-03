// OpenAI-compatible /v1/chat/completions served by the Claude Agent SDK under the local Claude Code login.
// A caller that owns its own agent loop and tools (robocoop-5) points its client's baseUrl here.
//
// The chat API is stateless and the SDK is not, so each conversation is one long-lived SDK query. The caller's
// tools are exposed to it as MCP tools whose handlers BLOCK: a tool call is answered to the HTTP caller as
// `tool_calls`, and the handler resolves when a later request carries the matching {role:'tool'} message.
// A request whose history is not an extension of a live conversation starts a new one from a text rendering
// of that history.
//
// Mounted by lopecode-channel.ts when LOPECODE_LLM_RUNNER=1, and served alone by claude-runner-cli.ts.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import type http from "node:http";

export type ClaudeRunnerOptions = {
  /** Bearer token a chat request must carry. A function, because the channel mints its token after binding. */
  token: () => string;
  /** Model for request ids that name no Claude model. Default: the CLI's own default. */
  defaultModel?: string;
  /** Working directory of the agent process. It runs no built-in tools; this only keeps it out of a project. */
  cwd?: string;
  /** The `claude` binary. Default: $LOPECODE_CLAUDE_PATH, else `claude` on PATH, else the SDK's bundled one. */
  claudePath?: string;
  log?: (...a: unknown[]) => void;
  verbose?: boolean;
};

let TOKEN: () => string = () => "";
let DEFAULT_MODEL: string | undefined;
let VERBOSE = false;
let CWD = "/tmp/lopecode-claude-runner";
let CLAUDE_PATH: string | undefined;
let logSink: (...a: unknown[]) => void = (...a) => console.error(...a);
const MAX_CONVS = 8;
const IDLE_MS = 60 * 60 * 1000;
const MCP = "rc5";
export const MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5", "claude-fable-5-1"];

// stdout belongs to MCP stdio when the channel hosts this, so logging never goes there by default.
const log = (...a: unknown[]) => logSink("[claude-runner]", new Date().toISOString().slice(11, 23), ...a);
const debug = (...a: unknown[]) => { if (VERBOSE) log(...a); };

// Loaded on the first chat request: the channel must start without it.
let query: any = null;
async function loadSdk() {
  if (query) return;
  ({ query } = await import("@anthropic-ai/claude-agent-sdk"));
  if (CLAUDE_PATH === undefined) {
    try { CLAUDE_PATH = execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || ""; } catch { CLAUDE_PATH = ""; }
  }
  mkdirSync(CWD, { recursive: true });
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

type Msg = { role: string; content?: any; tool_calls?: any[]; tool_call_id?: string };
type WireTool = { type: "function"; function: { name: string; description?: string; parameters?: any } };
type Block = { type: "text"; text: string } | { type: "image"; source: any };

// An id robocoop's picker may hold (an OpenRouter slug) → something the CLI accepts.
function resolveModel(id: unknown): string | undefined {
  const s = String(id ?? "").trim().replace(/^~/, "").replace(/^anthropic\//, "");
  if (MODELS.includes(s) || /^(opus|sonnet|haiku|fable)$/.test(s)) return s;
  // Any other Claude id (an older OpenRouter slug) → the current model of that family.
  const family = s.match(/claude-(?:[\d.-]+-)?(opus|sonnet|haiku|fable)/);
  return family ? family[1] : DEFAULT_MODEL;
}

function textOf(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content.map((p) => p?.type === "text" ? String(p.text ?? "")
    : p?.type === "image_url" ? "[image " + sha(String(p.image_url?.url ?? "")) + "]" : "").join("\n");
}

// Identity of a message for prefix matching. Ignores cache_control and string-vs-parts spelling, which the
// client rewrites between requests.
function keyOf(m: Msg): string {
  const calls = (m.tool_calls || []).map((c) => c?.id).join(",");
  return [m.role, m.tool_call_id || "", calls, sha(textOf(m.content))].join("|");
}
const assistantKey = (text: string, ids: string[]) => keyOf({ role: "assistant", content: text, tool_calls: ids.map((id) => ({ id })) });

function imageBlock(url: string): Block {
  const data = url.match(/^data:([^;,]+);base64,(.*)$/s);
  return data
    ? { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } }
    : { type: "image", source: { type: "url", url } };
}

// user/system messages → content blocks for ONE SDK user message. A system message has no slot once the
// conversation is running, so it travels as a tagged block.
function compose(msgs: Msg[]): Block[] {
  const out: Block[] = [];
  for (const m of msgs) {
    if (m.role === "system") {
      out.push({ type: "text", text: "<system-reminder>\n" + textOf(m.content) + "\n</system-reminder>" });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p?.type === "text" && p.text) out.push({ type: "text", text: String(p.text) });
        else if (p?.type === "image_url" && p.image_url?.url) out.push(imageBlock(p.image_url.url));
      }
    } else if (m.content != null && m.content !== "") out.push({ type: "text", text: String(m.content) });
  }
  return out;
}

function renderHistory(msgs: Msg[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    const text = textOf(m.content);
    if (m.role === "assistant") {
      if (text) lines.push("[assistant]\n" + text);
      for (const c of m.tool_calls || []) lines.push("[assistant called " + c?.function?.name + " id=" + c?.id + "]\n" + (c?.function?.arguments ?? ""));
    } else if (m.role === "tool") lines.push("[result of " + m.tool_call_id + "]\n" + text);
    else lines.push("[" + m.role + "]\n" + text);
  }
  return lines.join("\n\n");
}

// One model step, recorded so an HTTP response can attach late and replay it.
class Step {
  ops: any[] = [];
  done = false;
  listener: ((op: any) => void) | null = null;
  discarded = false;
  emit(op: any) {
    this.ops.push(op);
    if (op.t === "finish" || op.t === "fail") this.done = true;
    this.listener?.(op);
  }
  attach(fn: (op: any) => void) {
    for (const op of this.ops) fn(op);
    this.listener = fn;
  }
}

const stats = { requests: 0, continued: 0, started: 0, rebuilt: 0, interrupts: 0 };
let convSeq = 0;

class Conv {
  id = ++convSeq;
  seen: string[] = [];
  system: string | null;
  model: string | undefined;
  tools: WireTool[] = [];
  toolsKey = "";
  lastUsed = Date.now();
  dead = false;
  state: "idle" | "generating" | "awaiting_tools" = "idle";
  issued = new Set<string>();
  results = new Map<string, any>();
  handlers = new Map<string, (r: any) => void>();
  step: Step | null = null;        // step being generated
  unclaimed: Step[] = [];
  waiter: ((s: Step) => void) | null = null;
  cur: { text: string; calls: { id: string; name: string; args: string }[]; byIndex: Map<number, number>; stop: string | null; usage: any } | null = null;
  turnOpen = false;
  turnClosed: Promise<void> = Promise.resolve();
  closeTurn: (() => void) | null = null;
  discarding = false;
  lastError: string | null = null;
  relisted: (() => void) | null = null;
  queue: any[] = [];
  wake: (() => void) | null = null;
  server: Server;
  q: any;

  constructor(system: string | null, model: string | undefined, tools: WireTool[]) {
    this.system = system;
    this.model = model;
    this.setTools(tools);
    this.server = new Server({ name: MCP, version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.relisted?.();
      return {
        tools: this.tools.map((t) => ({
          name: t.function.name,
          description: String(t.function.description ?? ""),
          inputSchema: t.function.parameters?.type === "object" ? t.function.parameters : { type: "object", properties: {} },
          _meta: { "anthropic/alwaysLoad": true },
        })),
      };
    });
    this.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const id = String((req.params._meta as any)?.["claudecode/toolUseId"] ?? "");
      debug(`conv ${this.id} handler ${req.params.name} ${id}`);
      if (this.results.has(id)) { const r = this.results.get(id); this.results.delete(id); return r; }
      return await new Promise<any>((resolve) => this.handlers.set(id, resolve));
    });
    const self = this;
    async function* input() {
      for (;;) {
        while (self.queue.length) yield self.queue.shift();
        if (self.dead) return;
        await new Promise<void>((r) => (self.wake = r));
      }
    }
    this.q = query({
      prompt: input(),
      options: {
        ...(system != null ? { systemPrompt: system } : {}),
        ...(model ? { model } : {}),
        tools: [],
        mcpServers: { [MCP]: { type: "sdk", name: MCP, instance: this.server as any } },
        allowedTools: ["mcp__" + MCP],
        settingSources: [],
        // Without this the account's claude.ai connectors (Drive, Docs, …) are offered to the model too.
        strictMcpConfig: true,
        includePartialMessages: true,
        persistSession: false,
        verbatimPrompts: true,
        cwd: CWD,
        ...(CLAUDE_PATH ? { pathToClaudeCodeExecutable: CLAUDE_PATH } : {}),
        stderr: (d: string) => debug(`conv ${this.id} stderr`, d.trim().slice(0, 400)),
      } as any,
    });
    this.pump();
  }

  setTools(tools: WireTool[]) {
    this.tools = tools;
    this.toolsKey = sha(JSON.stringify(tools));
  }

  async updateTools(tools: WireTool[]) {
    this.setTools(tools);
    const relisted = new Promise<void>((r) => (this.relisted = r));
    await this.server.sendToolListChanged().catch(() => {});
    await Promise.race([relisted, new Promise((r) => setTimeout(r, 3000))]);
    this.relisted = null;
  }

  push(content: Block[]) {
    const body = content.every((b) => b.type === "text") ? content.map((b: any) => b.text).join("\n\n") : content;
    if (!this.turnOpen) {
      this.turnOpen = true;
      this.turnClosed = new Promise<void>((r) => (this.closeTurn = r));
    }
    this.queue.push({ type: "user", message: { role: "user", content: body }, parent_tool_use_id: null });
    this.wake?.();
  }

  resolveTool(id: string, text: string) {
    const result = { content: [{ type: "text", text }] };
    const h = this.handlers.get(id);
    if (h) { this.handlers.delete(id); h(result); } else this.results.set(id, result);
  }

  nextStep(): Promise<Step> {
    const s = this.unclaimed.shift();
    if (s) return Promise.resolve(s);
    return new Promise((r) => (this.waiter = r));
  }

  offer(s: Step) {
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(s); } else this.unclaimed.push(s);
  }

  async interrupt() {
    if (!this.turnOpen || this.dead) return;
    stats.interrupts++;
    this.discarding = true;
    if (this.step) this.step.discarded = true;
    for (const [id] of this.handlers) this.resolveTool(id, "interrupted");
    try { await this.q.interrupt(); } catch (e) { debug(`conv ${this.id} interrupt failed`, String(e)); }
  }

  close() {
    if (this.dead) return;
    this.dead = true;
    this.wake?.();
    for (const [id] of this.handlers) this.resolveTool(id, "conversation closed");
    try { this.q.close(); } catch {}
    this.closeTurn?.();
    const failed = new Step();
    failed.emit({ t: "fail", status: 400, message: "claude-runner: conversation closed" });
    if (this.step && !this.step.done) this.step.emit({ t: "fail", status: 400, message: "claude-runner: conversation closed" });
    if (this.waiter) this.offer(failed);
  }

  async pump() {
    try {
      for await (const m of this.q) this.onMessage(m);
    } catch (e: any) {
      this.lastError = String(e?.message ?? e);
      log(`conv ${this.id} query failed:`, this.lastError);
    }
    if (!this.dead) {
      const s = new Step();
      s.emit({ t: "fail", status: 400, message: "claude-runner: " + (this.lastError || "agent process ended") });
      if (this.step && !this.step.done) this.step.emit({ t: "fail", status: 400, message: "claude-runner: " + (this.lastError || "agent process ended") });
      else if (this.waiter) this.offer(s);
      this.close();
    }
  }

  onMessage(m: any) {
    if (m.type === "stream_event") {
      if (m.parent_tool_use_id || this.discarding) return;
      this.onEvent(m.event);
    } else if (m.type === "assistant") {
      if (m.error) this.lastError = textOf(m.message?.content?.filter?.((b: any) => b.type === "text")) || String(m.error);
    } else if (m.type === "result") {
      const stepless = this.waiter && !this.step;
      if (stepless && !this.discarding) {
        // The turn ended with no model step for the waiting request: an error, or a synthetic CLI reply.
        const s = new Step();
        if (m.is_error || this.lastError) {
          s.emit({ t: "fail", status: 400, message: "claude-runner: " + (this.lastError || (m.errors || []).join("; ") || m.subtype) });
        } else {
          s.emit({ t: "begin" });
          s.emit({ t: "delta", d: { content: String(m.result ?? "") } });
          s.emit({ t: "finish", reason: "stop", usage: null });
        }
        this.offer(s);
      }
      if (this.step && !this.step.done) this.step.emit({ t: "fail", status: 400, message: "claude-runner: turn ended mid-step (" + m.subtype + ")" });
      this.step = null;
      this.cur = null;
      this.lastError = null;
      this.discarding = false;
      this.state = "idle";
      this.issued.clear();
      this.turnOpen = false;
      this.closeTurn?.();
    } else if (m.type === "rate_limit_event") {
      debug(`conv ${this.id} rate limit`, JSON.stringify(m.rate_limit_info));
    }
  }

  onEvent(e: any) {
    if (e.type === "message_start") {
      this.cur = { text: "", calls: [], byIndex: new Map(), stop: null, usage: { ...(e.message?.usage || {}) } };
      this.step = new Step();
      this.state = "generating";
      this.step.emit({ t: "begin" });
      this.offer(this.step);
      return;
    }
    const cur = this.cur, step = this.step;
    if (!cur || !step) return;
    if (e.type === "content_block_start" && e.content_block?.type === "tool_use") {
      const idx = cur.calls.length;
      const name = String(e.content_block.name).replace(new RegExp("^mcp__" + MCP + "__"), "");
      cur.calls.push({ id: e.content_block.id, name, args: "" });
      cur.byIndex.set(e.index, idx);
      step.emit({ t: "delta", d: { tool_calls: [{ index: idx, id: e.content_block.id, type: "function", function: { name, arguments: "" } }] } });
    } else if (e.type === "content_block_delta") {
      const d = e.delta || {};
      if (d.type === "text_delta" && d.text) { cur.text += d.text; step.emit({ t: "delta", d: { content: d.text } }); }
      else if (d.type === "thinking_delta" && d.thinking) step.emit({ t: "delta", d: { reasoning: d.thinking } });
      else if (d.type === "input_json_delta" && cur.byIndex.has(e.index)) {
        const idx = cur.byIndex.get(e.index)!;
        cur.calls[idx].args += d.partial_json || "";
        if (d.partial_json) step.emit({ t: "delta", d: { tool_calls: [{ index: idx, function: { arguments: d.partial_json } }] } });
      }
    } else if (e.type === "message_delta") {
      cur.stop = e.delta?.stop_reason ?? cur.stop;
      Object.assign(cur.usage, e.usage || {});
    } else if (e.type === "message_stop") {
      const ids = cur.calls.map((c) => c.id);
      if (ids.length) { this.state = "awaiting_tools"; this.issued = new Set(ids); } else this.state = "idle";
      if (!step.discarded && (cur.text || ids.length)) this.seen.push(assistantKey(cur.text, ids));
      const u = cur.usage;
      const cached = u.cache_read_input_tokens || 0;
      step.emit({
        t: "finish",
        reason: ids.length ? "tool_calls" : cur.stop === "max_tokens" ? "length" : "stop",
        usage: {
          prompt_tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + cached,
          completion_tokens: u.output_tokens || 0,
          prompt_tokens_details: { cached_tokens: cached },
          completion_tokens_details: { reasoning_tokens: u.output_tokens_details?.thinking_tokens || 0 },
          cost: 0,
        },
      });
      this.step = null;
      this.cur = null;
    }
  }
}

const convs = new Set<Conv>();

function sweep() {
  const now = Date.now();
  for (const c of convs) if (c.dead || now - c.lastUsed > IDLE_MS) { c.close(); convs.delete(c); }
  const live = [...convs].sort((a, b) => a.lastUsed - b.lastUsed);
  while (live.length >= MAX_CONVS) { const c = live.shift()!; c.close(); convs.delete(c); }
}

function match(keys: string[]): Conv | null {
  let best: Conv | null = null;
  for (const c of convs) {
    if (c.dead || c.seen.length > keys.length || c.seen.length === 0) continue;
    if (!c.seen.every((k, i) => k === keys[i])) continue;
    if (!best || c.seen.length > best.seen.length) best = c;
  }
  return best;
}

// Returns the step that answers this request.
async function route(body: any): Promise<{ conv: Conv; step: Promise<Step>; how: string }> {
  const messages: Msg[] = Array.isArray(body.messages) ? body.messages : [];
  const tools: WireTool[] = Array.isArray(body.tools) ? body.tools : [];
  const model = resolveModel(body.model);
  const keys = messages.map(keyOf);
  sweep();

  let conv = match(keys);
  if (conv) {
    const delta = messages.slice(conv.seen.length);
    if (conv.state !== "awaiting_tools") await Promise.race([conv.turnClosed, new Promise((r) => setTimeout(r, 15000))]);
    const toolMsgs = delta.filter((m) => m.role === "tool");
    const extras = delta.filter((m) => m.role === "user" || m.role === "system");
    const answered = new Set(toolMsgs.map((m) => m.tool_call_id));
    const consistent = conv.state === "awaiting_tools"
      ? [...conv.issued].every((id) => answered.has(id))
      : conv.state === "idle" && !conv.turnOpen && toolMsgs.length === 0;
    if (!consistent || conv.dead) {
      debug(`conv ${conv.id} inconsistent with request (state ${conv.state}), rebuilding`);
      conv.close(); convs.delete(conv); conv = null;
    } else {
      stats.continued++;
      if (model !== conv.model) { conv.model = model; await conv.q.setModel(model).catch((e: any) => debug("setModel failed", String(e))); }
      if (sha(JSON.stringify(tools)) !== conv.toolsKey) await conv.updateTools(tools);
      conv.seen = keys.slice();
      conv.lastUsed = Date.now();
      const step = conv.nextStep();
      const blocks = compose(extras);
      if (conv.state === "awaiting_tools") {
        // A user/system message queued before the results is read by the model together with them.
        if (blocks.length) conv.push(blocks);
        for (const m of toolMsgs) conv.resolveTool(String(m.tool_call_id), textOf(m.content));
        conv.issued.clear();
      } else {
        conv.push(blocks.length ? blocks : [{ type: "text", text: "<system-reminder>\nYour previous reply was interrupted before it was delivered. Respond to the conversation above.\n</system-reminder>" }]);
      }
      conv.state = "generating";
      return { conv, step, how: `continue +${delta.length}` };
    }
  }

  const hasSystem = messages[0]?.role === "system";
  const rest = hasSystem ? messages.slice(1) : messages;
  let tailStart = rest.length;
  while (tailStart > 0 && (rest[tailStart - 1].role === "user" || rest[tailStart - 1].role === "system")) tailStart--;
  const history = rest.slice(0, tailStart), tail = rest.slice(tailStart);
  const blocks: Block[] = [];
  if (history.length) {
    stats.rebuilt++;
    blocks.push({
      type: "text",
      text: "<conversation-history>\nThe conversation so far, as text. Tool calls in it already ran; do not repeat them.\n\n" +
        renderHistory(history) + "\n</conversation-history>" + (tail.length ? "" : "\n\nContinue from where the history ends."),
    });
  } else stats.started++;
  blocks.push(...compose(tail));
  if (!blocks.length) blocks.push({ type: "text", text: "(no input)" });
  await loadSdk();
  conv = new Conv(hasSystem ? textOf(messages[0].content) : null, model, tools);
  convs.add(conv);
  conv.seen = keys.slice();
  const step = conv.nextStep();
  conv.push(blocks);
  conv.state = "generating";
  return { conv, step, how: history.length ? `rebuild from ${history.length}` : "new" };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Private-Network": "true",
  "Access-Control-Max-Age": "86400",
};
const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { ...CORS, "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

async function chat(req: http.IncomingMessage, res: http.ServerResponse, body: any) {
  stats.requests++;
  const t0 = Date.now();
  const stream = body.stream !== false;
  const id = "chatcmpl-" + randomBytes(8).toString("hex");
  let conv: Conv | null = null, finished = false;
  res.on("close", () => { if (!finished && conv) { debug(`conv ${conv.id} client aborted`); conv.interrupt(); } });

  const routed = await route(body);
  conv = routed.conv;
  if (res.destroyed) { conv.interrupt(); return; }
  const step = await routed.step;

  const acc = { content: "", reasoning: "", calls: [] as any[] };
  let begun = false;
  const chunk = (delta: any, finish: string | null, extra: any = {}) =>
    res.write("data: " + JSON.stringify({ id, object: "chat.completion.chunk", model: body.model, provider: "claude-code", choices: [{ index: 0, delta, finish_reason: finish }], ...extra }) + "\n\n");
  const beat = setInterval(() => { if (begun && stream && !finished) chunk({}, null); }, 15000);
  step.attach((op) => {
    if (finished || res.destroyed) return;
    if (op.t === "begin") {
      begun = true;
      if (stream) { res.writeHead(200, { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }); chunk({ role: "assistant" }, null); }
    } else if (op.t === "delta") {
      if (op.d.content) acc.content += op.d.content;
      if (op.d.reasoning) acc.reasoning += op.d.reasoning;
      for (const tc of op.d.tool_calls || []) {
        const slot = acc.calls[tc.index] || (acc.calls[tc.index] = { id: "", type: "function", function: { name: "", arguments: "" } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name = tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
      if (stream) chunk(op.d, null);
    } else if (op.t === "finish") {
      finished = true;
      clearInterval(beat);
      if (stream) {
        chunk({}, op.reason, op.usage ? { usage: op.usage } : {});
        res.end("data: [DONE]\n\n");
      } else {
        const message: any = { role: "assistant", content: acc.content || null };
        if (acc.calls.length) message.tool_calls = acc.calls;
        if (acc.reasoning) message.reasoning = acc.reasoning;
        json(res, 200, { id, object: "chat.completion", model: body.model, provider: "claude-code", choices: [{ index: 0, message, finish_reason: op.reason }], usage: op.usage });
      }
      log(`conv ${conv!.id} ${routed.how} model=${conv!.model ?? "default"} → ${op.reason}${acc.calls.length ? " [" + acc.calls.map((c) => c.function.name).join(",") + "]" : ""} ${op.usage?.prompt_tokens ?? "?"}/${op.usage?.completion_tokens ?? "?"} tok (${op.usage?.prompt_tokens_details?.cached_tokens ?? 0} cached) ${Date.now() - t0}ms`);
    } else if (op.t === "fail") {
      finished = true;
      clearInterval(beat);
      log(`conv ${conv!.id} ${routed.how} FAILED: ${op.message}`);
      if (res.headersSent) res.end("data: " + JSON.stringify({ error: { message: op.message } }) + "\n\n");
      else json(res, op.status, { error: { message: op.message } });
    }
  });
}

export function createClaudeRunner(opts: ClaudeRunnerOptions) {
  TOKEN = opts.token;
  DEFAULT_MODEL = opts.defaultModel;
  VERBOSE = !!opts.verbose;
  if (opts.cwd) CWD = opts.cwd;
  CLAUDE_PATH = opts.claudePath ?? (process.env.LOPECODE_CLAUDE_PATH?.trim() || undefined);
  if (opts.log) logSink = opts.log;

  // Answers /v1/* and returns true; any other path returns false untouched.
  function handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const path = new URL(req.url || "/", "http://127.0.0.1").pathname.replace(/\/+$/, "");
    if (!path.startsWith("/v1")) return false;
    (async () => {
      if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
      if (req.method === "GET" && path === "/v1/models") {
        return json(res, 200, {
          data: MODELS.map((id) => ({ id, name: id, supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"] }, pricing: { prompt: "0", completion: "0" } })),
        });
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        const token = TOKEN();
        if (!token || (req.headers.authorization || "") !== "Bearer " + token) return json(res, 401, { error: { message: "claude-runner: bad or missing token" } });
        const parts: Buffer[] = [];
        for await (const c of req) parts.push(c as Buffer);
        let body: any;
        try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { return json(res, 400, { error: { message: "claude-runner: body is not JSON" } }); }
        return await chat(req, res, body);
      }
      json(res, 404, { error: { message: "not found" } });
    })().catch((e: any) => {
      log("request failed:", e?.stack || String(e));
      if (!res.headersSent) json(res, 400, { error: { message: "claude-runner: " + String(e?.message ?? e) } });
      else res.end();
    });
    return true;
  }

  return {
    handle,
    cors: CORS,
    status: () => ({ stats: { ...stats }, convs: [...convs].map((c) => ({ id: c.id, state: c.state, seen: c.seen.length, model: c.model ?? null, dead: c.dead })) }),
    close: () => { for (const c of convs) c.close(); convs.clear(); },
  };
}
