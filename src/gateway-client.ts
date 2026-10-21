import { setTimeout as delay } from "node:timers/promises";
import type { DurableController, DurableView, DurableViewSource, Inspection } from "./tui-adapter.ts";
import type { GatewayFrame } from "./gateway.ts";
import { localVoice, type VoiceEvent } from "./voice.ts";

/** The Mac owns audio and rendering; the gateway owns all agent state and execution. */
export async function connectGateway(url: string, token: string, dataDir: string, audio = localVoice) {
  const base = new URL(url);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/")
    throw new Error("Use an HTTP(S) gateway origin without credentials, path, or query.");
  if (!token || /\s/.test(token)) throw new Error("Set GATEWAY_TOKEN on the Mac to match the gateway.");
  const lifetime = new AbortController();
  let snapshot!: DurableView, session = "", connected = false;
  let stream: AbortController | undefined;
  let voice: { id: string; engine: ReturnType<typeof localVoice> } | undefined;
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  const stopAudio = () => { voice?.engine.stop(); voice = undefined; };
  const notice = (message: string) => {
    if (!snapshot) return;
    snapshot = { ...snapshot, voice: undefined, notices: [...snapshot.notices.slice(-9), { id: Date.now(), level: "error", message }] };
    changed();
  };
  const request = async (path: string, value?: object) => {
    if (!connected) throw new Error("Gateway disconnected. This command was not sent.");
    const requestedSession = session;
    const response = await fetch(new URL(path, base), {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Sage-Session": session, "Content-Type": "application/json" },
      ...(value ? { body: JSON.stringify(value) } : {}), redirect: "error",
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) throw new Error(`Gateway returned HTTP ${response.status}. Command was not retried; check the transcript.`);
    const result = await response.json() as { result: unknown; view?: DurableView };
    if (result.view && connected && session === requestedSession) { snapshot = result.view; changed(); }
    return result.result;
  };
  const call = async (value: object) => {
    try { return await request("/v1/command", value); }
    catch (error) { notice(error instanceof Error ? error.message : "Gateway command failed. It was not retried."); }
  };
  let audioQueue = Promise.resolve(), lastLevel = 0;
  const receiveAudio = (frame: Extract<GatewayFrame, { type: "audio" }>) => {
    if (frame.action === "start") {
      stopAudio();
      const sendEvent = (event: VoiceEvent) => {
        if (!connected || voice?.id !== frame.id) return;
        if (event.type === "level" && Date.now() - lastLevel < 100) return;
        if (event.type === "level") lastLevel = Date.now();
        // PCM never leaves this process. Preserve event ordering across HTTP requests.
        const { pcm: _pcm, sampleRate: _sampleRate, ...status } = event;
        audioQueue = audioQueue.then(async () => {
          if (voice?.id === frame.id && connected) await request("/v1/audio", { ...status, voice: frame.id });
        }).catch(() => { stopAudio(); stream?.abort(); });
      };
      try {
        const engine = audio({ dataDir }, sendEvent);
        voice = { id: frame.id, engine };
        void engine.start().catch((error) => sendEvent({ type: "error", message: error instanceof Error ? error.message : "Local audio failed." }));
      } catch { void request("/v1/audio", { voice: frame.id, type: "error", message: "Local audio could not start." }).catch(() => stream?.abort()); }
      return;
    }
    if (voice?.id !== frame.id) return;
    if (frame.action === "stop") stopAudio();
    else if (frame.action === "interrupt") voice.engine.interrupt();
    else if (frame.action === "finish") voice.engine.finish();
    else if (frame.action === "speak" && frame.text) voice.engine.speak(frame.text);
  };
  const attach = async (initial: boolean) => {
    stream = new AbortController();
    const attaching = stream;
    let seen = Date.now();
    const watchdog = setInterval(() => { if (Date.now() - seen > 15000) attaching.abort(); }, 5000);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      const response = await fetch(new URL("/v1/attach", base), {
        headers: { Authorization: `Bearer ${token}` }, redirect: "error",
        signal: AbortSignal.any([lifetime.signal, attaching.signal]),
      });
      if (!response.ok || !response.body) throw new Error(`Could not attach to gateway (HTTP ${response.status}).`);
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let pending = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) throw new Error("Gateway connection closed.");
          seen = Date.now();
          pending += decoder.decode(value, { stream: true });
          if (pending.length > 32 * 1024 * 1024) throw new Error("Gateway frame too large.");
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const frame = JSON.parse(pending.slice(0, newline)) as GatewayFrame;
            pending = pending.slice(newline + 1);
            if (frame.type === "view") {
              if (typeof frame.session !== "string" || !frame.view?.conversation) throw new Error("Invalid gateway snapshot.");
              session = frame.session; snapshot = frame.view; connected = true; changed();
              if (!heartbeat) heartbeat = setInterval(() => { void request("/v1/heartbeat").catch(() => attaching.abort()); }, 5000);
              if (initial) ready();
            } else if (frame.type === "audio") receiveAudio(frame);
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
    } finally { clearInterval(watchdog); clearInterval(heartbeat); }
  };
  let ready!: () => void, failed!: (error: unknown) => void;
  const first = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
  const running = (async () => {
    let initial = true;
    while (!lifetime.signal.aborted) {
      try { await attach(initial); }
      catch (error) {
        connected = false; stopAudio();
        if (lifetime.signal.aborted) return;
        if (!snapshot) { failed(error); return; }
        notice("Gateway disconnected. Reconnecting; microphone stopped. Submitted commands are never replayed.");
      }
      initial = false;
      await delay(1000, undefined, { signal: lifetime.signal }).catch(() => {});
    }
  })();
  await first;
  const controller: DurableController = {
    submit: async (text, mode) => {
      if (!/^\/speak(?:\s+on)?$/.test(text.trim())) stopAudio();
      await call({ method: "submit", text, mode });
    },
    compact: async (instructions) => { await call({ method: "compact", instructions }); },
    abort: async () => { stopAudio(); await call({ method: "abort" }); },
    cycleThinking: async () => { await call({ method: "cycleThinking" }); },
    refreshModels: async () => { await call({ method: "refreshModels" }); },
    setModel: async (model) => { await call({ method: "setModel", ...model }); },
    toggleTasks: async () => { await call({ method: "toggleTasks" }); },
    newSession: async () => { stopAudio(); await call({ method: "newSession" }); },
    inspect: async (kind) => await call({ method: "inspect", kind }) as Inspection | undefined,
    switchConversation: async (id) => { stopAudio(); await call({ method: "switchConversation", id }); },
  };
  const source: DurableViewSource = { current: () => snapshot, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
  return { source, controller, async dispose() {
    stopAudio();
    if (connected) await request("/v1/detach").catch(() => {});
    connected = false; lifetime.abort(); stream?.abort();
    await running; listeners.clear();
  } };
}
