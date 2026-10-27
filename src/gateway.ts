import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Assistant } from "./assistant.ts";
import type { Config } from "./config.ts";
import { tuiAdapter, type DurableController, type DurableView } from "./tui-adapter.ts";
import type { VoiceEvent } from "./voice.ts";

export type GatewayFrame =
  | { type: "view"; session: string; view: DurableView }
  | { type: "audio"; id: string; action: "start" | "stop" | "interrupt" | "finish" | "speak"; text?: string }
  | { type: "ping" };

class RequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new RequestError("Expected JSON.", 415);
  if (Number(request.headers["content-length"]) > 131072) throw new RequestError("Request too large.", 413);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 131072) throw new RequestError("Request too large.", 413);
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Return a bounded diagnostic, never the submitted content. */ }
  throw new RequestError("Invalid JSON object.");
}

function text(value: unknown, max = 65536): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new RequestError("Invalid text.");
  return value;
}

async function command(controller: DurableController, value: Record<string, unknown>) {
  switch (value.method) {
    case "submit":
      if (value.mode !== "steer" && value.mode !== "followUp") throw new RequestError("Invalid submission mode.");
      return controller.submit(text(value.text), value.mode);
    case "compact": return controller.compact(value.instructions === undefined ? undefined : text(value.instructions));
    case "abort": return controller.abort();
    case "cycleThinking": return controller.cycleThinking();
    case "refreshModels": return controller.refreshModels();
    case "toggleTasks": return controller.toggleTasks();
    case "newSession": return controller.newSession();
    case "setModel": return controller.setModel({ provider: text(value.provider, 256), modelId: text(value.modelId, 256) });
    case "inspect":
      if (value.kind !== "skills" && value.kind !== "memory" && value.kind !== "schedules") throw new RequestError("Invalid inspector.");
      return controller.inspect(value.kind);
    case "switchConversation":
      if (!Number.isSafeInteger(value.id) || Number(value.id) <= 0) throw new RequestError("Invalid conversation.");
      return controller.switchConversation(value.id as ConversationId);
    default: throw new RequestError("Unknown command.");
  }
}

// Only recognition text and status cross the network; microphone PCM and TTS stay on the Mac.
export function voiceEvent(value: Record<string, unknown>): VoiceEvent {
  const types = ["ready", "calibrating", "calibrated", "level", "speech_start", "speech_end", "speech_discarded", "transcript", "audio", "audio_end", "error"];
  if (!types.includes(String(value.type))) throw new RequestError("Invalid audio event.");
  const event: VoiceEvent = { type: value.type as VoiceEvent["type"] };
  for (const key of ["id", "epoch", "endedAt", "asrDoneAt", "value"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "number" || !Number.isFinite(value[key])) throw new RequestError("Invalid audio timing.");
      event[key] = value[key];
    }
  }
  if (value.text !== undefined) {
    if (typeof value.text !== "string" || value.text.length > 65536) throw new RequestError("Invalid transcript.");
    event.text = value.text;
  }
  if (value.message !== undefined) event.message = text(value.message, 4000);
  if (event.type === "transcript" && (event.text === undefined || event.id === undefined || event.endedAt === undefined || event.asrDoneAt === undefined))
    throw new RequestError("Missing transcript fields.");
  if (event.type === "speech_start" && event.id === undefined) throw new RequestError("Missing speech ID.");
  return event;
}

/** A private terminal API over the existing Pi view/controller. One interactive client at a time. */
export async function openGateway(assistant: Assistant, config: Config,
  options: { token: string; host?: string; port?: number; leaseMs?: number }) {
  if (options.token.length < 32 || /\s/.test(options.token)) throw new Error("GATEWAY_TOKEN must contain at least 32 non-whitespace characters.");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(`Bearer ${options.token}`);
  const leaseMs = options.leaseMs ?? 20000;
  let occupied = false;
  let client: { id: string; adapter: Awaited<ReturnType<typeof tuiAdapter>>; response: ServerResponse;
    voice?: { id: string; receive: (event: VoiceEvent) => void }; seen: number;
    queue: Promise<unknown>; dispose(): Promise<void> } | undefined;
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(error instanceof RequestError ? error.status : 500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: error instanceof RequestError ? error.message : "Gateway request failed." }));
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;

  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/health" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" })); return;
    }
    if (request.headers.origin) throw new RequestError("Browser origins are not supported.", 403);
    if (!timingSafeEqual(digest(request.headers.authorization ?? ""), expected)) throw new RequestError("Unauthorized.", 401);
    if (request.url === "/v1/attach" && request.method === "GET") {
      if (occupied) throw new RequestError("Another TUI is attached. Disconnect it first.", 409);
      occupied = true;
      let adapter: Awaited<ReturnType<typeof tuiAdapter>>;
      const id = randomUUID();
      let audio: { id: string; receive: (event: VoiceEvent) => void } | undefined;
      let closed = false, dirty = false, disposal: Promise<void> | undefined;
      const send = (frame: GatewayFrame) => {
        if (closed || response.destroyed) return;
        // ponytail: full snapshots; use native Pi watch deltas if long chats make bandwidth significant.
        if (response.writableLength > 4 * 1024 * 1024) { response.destroy(); return; }
        response.write(JSON.stringify(frame) + "\n");
      };
      try {
        adapter = await tuiAdapter(assistant, config, (_config, receive) => {
          const voiceId = randomUUID();
          audio = { id: voiceId, receive };
          const action = (action: "start" | "stop" | "interrupt" | "finish" | "speak", text?: string) =>
            send({ type: "audio", id: voiceId, action, ...(text === undefined ? {} : { text }) });
          return { start: async () => { action("start"); },
            stop: () => { action("stop"); if (audio?.id === voiceId) audio = undefined; },
            interrupt: () => action("interrupt"), finish: () => action("finish"), speak: (phrase) => action("speak", phrase) };
        });
      } catch (error) { occupied = false; throw error; }
      const unsubscribe = adapter.source.subscribe(() => { dirty = true; });
      const update = () => { dirty = false; send({ type: "view", session: id, view: adapter.source.current() }); };
      const refresh = setInterval(() => { if (dirty && !response.writableNeedDrain) update(); }, 100);
      const heartbeat = setInterval(() => {
        if (Date.now() - attached.seen > leaseMs) { void attached.dispose().catch(() => {}); return; }
        send({ type: "ping" });
      }, Math.min(5000, leaseMs));
      const attached = { id, adapter, response, seen: Date.now(), queue: Promise.resolve() as Promise<unknown>,
        get voice() { return audio; },
        dispose(): Promise<void> {
          if (disposal) return disposal;
          closed = true;
          clearInterval(refresh); clearInterval(heartbeat); unsubscribe();
          response.end();
          disposal = (async () => {
            try { await attached.queue; await adapter.dispose(); }
            finally { if (client === attached) client = undefined; occupied = false; }
          })();
          return disposal;
        },
      };
      client = attached;
      response.on("close", () => { void attached.dispose().catch(() => {}); });
      if (response.destroyed) { await attached.dispose(); return; }
      response.writeHead(200, { "Content-Type": "application/x-ndjson", "X-Accel-Buffering": "no" });
      response.flushHeaders(); update();
      return;
    }
    const attached = client;
    if (!attached || attached.response.writableEnded || request.headers["x-sage-session"] !== attached.id) throw new RequestError("Attach a TUI first.", 409);
    attached.seen = Date.now();
    let result: unknown;
    if (request.url === "/v1/detach" && request.method === "POST") await attached.dispose();
    else if (request.url === "/v1/heartbeat" && request.method === "POST") { /* renew the client lease */ }
    else if (request.url === "/v1/audio" && request.method === "POST") {
      const value = await body(request);
      const event = voiceEvent(value);
      const voice = attached.voice;
      if (voice && voice.id === value.voice) voice.receive(event);
    } else if (request.url === "/v1/command" && request.method === "POST") {
      const value = await body(request);
      const run = attached.queue.then(() => {
        if (client !== attached || attached.response.writableEnded) throw new RequestError("Client disconnected.", 409);
        return command(attached.adapter.controller, value);
      });
      attached.queue = run.catch(() => {});
      result = await run;
    } else throw new RequestError("Unknown endpoint.", 404);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ result: result ?? null,
      ...(request.url === "/v1/command" ? { view: attached.adapter.source.current() } : {}) }));
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, options.host ?? "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return { server, async close() {
    const closing = new Promise<void>((resolve) => server.close(() => resolve()));
    try { await client?.dispose(); }
    finally { server.closeAllConnections(); await closing; }
  } };
}
