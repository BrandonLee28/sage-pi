import type {
  AgentState,
  ConversationView,
  ConversationId,
  ModelRef,
  TaskGraph,
  Conversation,
} from "@earendil-works/pi-durable";
import { AgentDoc, configure } from "@earendil-works/pi-durable";
import { context, TelegramTopics, TuiSessions, USER_PROFILE_MAX_CHARS, type Assistant } from "./assistant.ts";
import { PINNED_MEMORY_LIMIT } from "./personal.ts";
import { Routines } from "../extensions/routines.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { localVoice, type VoiceEvent } from "./voice.ts";
import { voiceReply } from "./voice-reply.ts";
import { voiceExtension, VoiceMode } from "../extensions/voice.ts";

// This is the view/controller contract of Pi's original durable TUI example.
export type DurableView = {
  session: { id: string; directory: string; cwd: string };
  conversation: ConversationView;
  conversations: { id: ConversationId; label: string; title?: string }[];
  models: (ModelRef & { name: string; contextWindow: number })[];
  notices: {
    id: number;
    level: "info" | "warning" | "error";
    message: string;
  }[];
  tasks?: TaskGraph;
};
export type DurableViewSource = {
  current(): DurableView;
  subscribe(listener: () => void): () => void;
};
export type Inspection = {
  title: string;
  description: string;
  items: { value: string; label: string; description: string; body: string }[];
};
export type DurableController = {
  submit(text: string, whenBusy: "steer" | "followUp"): Promise<void>;
  compact(instructions: string | undefined): Promise<void>;
  abort(): Promise<void>;
  cycleThinking(): Promise<void>;
  refreshModels(): Promise<void>;
  setModel(model: ModelRef): Promise<void>;
  toggleTasks(): Promise<void>;
  newSession(): Promise<void>;
  inspect(kind: "skills" | "memory" | "schedules"): Promise<Inspection | undefined>;
  switchConversation(id: ConversationId): Promise<void>;
};
export const agentOf = (view: ConversationView): AgentState =>
  (view.docs["pi.agent"] ?? {}) as AgentState;

export async function tuiAdapter(assistant: Assistant, config: Config, audio = localVoice) {
  const sessions = await assistant.harness.documentState(TuiSessions, context);
  if (!sessions) throw new Error("Missing TUI session index.");
  let selected = sessions.value?.active
    ? await assistant.harness.conversation(sessions.value.active, context) ?? assistant.root
    : assistant.root;
  let conversation = await selected.viewState(context);
  const topics = await assistant.harness.documentState(TelegramTopics, context);
  if (!topics) throw new Error("Missing Telegram conversation index.");
  const tasks = await assistant.harness.taskGraph(context);
  const listeners = new Set<() => void>();
  const notices: DurableView["notices"] = [];
  let showTasks = false;
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const notice = (message: string, level: "info" | "error" = "info") => {
    notices.push({ id: Date.now(), level, message });
    if (notices.length > 10) notices.shift();
    changed();
  };
  const report = (error: unknown) =>
    notice(error instanceof Error ? error.message : String(error), "error");
  let voice: { audio: ReturnType<typeof localVoice>; conversation: Conversation;
    turn: AbortController;
    utterance: number; interrupting: Promise<void>; firstPCM: boolean; endedAt: number;
    asrDoneAt: number; firstTextAt: number } | undefined;
  assistant.registry.install(voiceExtension(assistant.workspace, (id) => voice?.conversation.id === id));
  const stopVoice = async () => {
    const previous = voice;
    voice = undefined;
    if (!previous) return;
    previous.turn.abort();
    previous.audio.stop();
    await previous.interrupting;
    await previous.conversation.abort(context);
    await previous.conversation.commit(async (tx) => {
      const lease = await tx.doc(VoiceMode, previous.conversation.id);
      const agent = await tx.doc(AgentDoc, previous.conversation.id);
      if (agent.thinkingLevel === "off" && lease.previousThinking)
        await configure(tx, previous.conversation.id, { thinkingLevel: lease.previousThinking });
      lease.previousThinking = null;
    }, context);
    notice("Voice off. Microphone and playback stopped.");
  };
  const startVoice = async () => {
    if (voice) { notice("Voice is on. Speak naturally; /speak off closes the microphone."); return; }
    if (conversation.value.docs["pi.live"]?.run) throw new Error("Stop current work before starting voice mode.");
    const target = selected;
    const previousThinking = agentOf(conversation.value).thinkingLevel;
    const onVoice = (event: VoiceEvent) => {
      const current = voice;
      if (!current || current.conversation.id !== target.id) return;
      if (event.type === "ready") notice("Listening · hands-free · use headphones · /speak off to stop");
      if (event.type === "speech_start") {
        current.utterance = event.id!;
        current.turn.abort();
        current.audio.interrupt();
        current.interrupting = current.interrupting.then(() => target.abort(context));
        void current.interrupting.catch(report);
        notice("Listening…");
      }
      if (event.type === "speech_end") notice("Transcribing…");
      if (event.type === "transcript" && event.id === current.utterance) {
        if (!event.text?.trim()) { notice("No words recognized. Listening…"); return; }
        current.turn = new AbortController();
        const turn = current.turn;
        current.endedAt = event.endedAt!; current.asrDoneAt = event.asrDoneAt!;
        current.firstPCM = false; current.firstTextAt = 0;
        notice("Thinking…");
        void current.interrupting.then(async () => {
          if (turn.signal.aborted || voice !== current) return;
          await voiceReply(assistant, target, event.text!, turn.signal,
            (phrase) => { if (!turn.signal.aborted) current.audio.speak(phrase); },
            () => { current.firstTextAt = Date.now(); });
          if (!turn.signal.aborted && voice === current) current.audio.finish();
        }).catch((error) => { if (!turn.signal.aborted) { current.audio.interrupt(); report(error); } });
      }
      if (event.type === "audio" && !current.firstPCM) {
        current.firstPCM = true;
        notice(`Speaking · first PCM ${Math.round(Date.now() - current.endedAt)} ms (+ playback) · pause/ASR ${Math.round(current.asrDoneAt - current.endedAt)} ms · model ${Math.round(current.firstTextAt - current.asrDoneAt)} ms`);
      }
      if (event.type === "audio_end") notice("Listening · ready for another turn");
      if (event.type === "error") { report(event.message ?? "Voice failed."); void stopVoice().catch(report); }
    };
    const engine = audio(config, onVoice);
    voice = { audio: engine, conversation: target, turn: new AbortController(),
      utterance: 0, interrupting: Promise.resolve(), firstPCM: false, endedAt: 0, asrDoneAt: 0, firstTextAt: 0 };
    notice("Loading local speech models… First use downloads model files. Microphone opens after loading.");
    try {
      await target.commit(async (tx) => {
        (await tx.doc(VoiceMode, target.id)).previousThinking = previousThinking ?? "low";
        await configure(tx, target.id, { thinkingLevel: "off" });
      }, context);
      await engine.start();
    } catch (error) { await stopVoice(); throw error; }
  };
  const source: DurableViewSource = {
    current: () => ({
      session: {
        id: "personal",
        directory: config.dataDir,
        cwd: assistant.workspace,
      },
      conversation: conversation.value,
      conversations: [
        { id: assistant.root.id, label: "main" },
        ...(sessions.value?.conversations ?? []).map((id, index) => ({ id, label: `Session ${index + 1}` })),
        ...Object.entries(topics.value?.conversations ?? {}).map(([thread, id]) =>
          ({ id, label: `Telegram thread ${thread}` })),
      ],
      models: assistant.models
        .getModels()
        .map((m) => ({
          provider: m.provider,
          modelId: m.id,
          name: m.name,
          contextWindow: m.contextWindow,
        })),
      notices,
      ...(showTasks ? { tasks: tasks.value } : {}),
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const guard = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      report(error);
    }
  };
  const controller: DurableController = {
    submit: (text, mode) =>
      guard(async () => {
        if (/^\/speak(?:\s|$)/.test(text.trim())) {
          if (text.trim() === "/speak off") return stopVoice();
          if (["/speak", "/speak on"].includes(text.trim())) return startVoice();
          throw new Error("Use /speak, /speak on, or /speak off.");
        }
        if (text.trim() === "/new") return controller.newSession();
        if (text.trim() === "/help") {
          notice(
            "/speak hands-free local voice · /speak off stop microphone · /new new session · /sessions saved chats · /skills, /memory, /schedules (/crons) read-only inspectors · /model · /tasks task graph · /compact [instructions] · Esc stop · Ctrl+O expand tools · Ctrl+C exit.",
          );
          return;
        }
        await stopVoice();
        const submission = await assistant.submit(
          text,
          undefined,
          false,
          mode === "steer",
          selected,
        );
        void submission
          .wait(context)
          .then((result) => {
            if (result.status === "unanswered")
              notice(`Request ended: ${result.reason}`, "error");
          })
          .catch(report);
      }),
    compact: (instructions) =>
      guard(async () => {
        if (conversation.value.docs["pi.live"]?.run) {
          notice("Wait until current work finishes before compacting.");
          return;
        }
        await selected.compact(instructions, context);
      }),
    abort: () => guard(async () => { await stopVoice(); await selected.abort(context); }),
    cycleThinking: () => guard(async () => {
      const agent = agentOf(conversation.value);
      const model = agent.model && assistant.models.getModel(agent.model.provider, agent.model.modelId);
      if (!model) throw new Error("Model is not configured.");
      const levels = getSupportedThinkingLevels(model);
      const next = levels[(levels.indexOf(agent.thinkingLevel ?? "low") + 1) % levels.length];
      await selected.configure({ thinkingLevel: next }, context);
    }),
    refreshModels: () => guard(async () => {
      const result = await assistant.models.refresh({ providers: ["local"], force: true });
      for (const error of result.errors.values()) report(error);
      changed();
    }),
    setModel: (model) =>
      guard(async () => {
        await stopVoice();
        const available = assistant.models.getModel(model.provider, model.modelId);
        if (!available)
          throw new Error("Model is not configured.");
        await selected.configure({
          model,
          thinkingLevel: clampThinkingLevel(available, agentOf(conversation.value).thinkingLevel ?? "low"),
        }, context);
      }),
    toggleTasks: async () => {
      showTasks = !showTasks;
      changed();
    },
    newSession: () => guard(async () => {
      await stopVoice();
      const created = await assistant.createSession(selected.id);
      await controller.switchConversation(created.id);
    }),
    inspect: async (kind) => {
      try {
        if (kind === "schedules") {
          const [state, { commitments }] = await Promise.all([
            assistant.harness.snapshot(Routines, context), assistant.personalState(),
          ]);
          const routines = Object.values(state?.items ?? {});
          const reminders = commitments.filter((item) => item.wakeAt !== null);
          const local = (at: number | null, timezone: string) => at === null ? "None" : `${new Date(at).toLocaleString("en-US", { timeZone: timezone })} (${timezone})`;
          const utc = (at: number | null) => at === null ? "None" : new Date(at).toISOString();
          return {
            title: "Schedules",
            description: `${routines.length} recurring · ${reminders.length} reminders · shared across sessions${!routines.length && !reminders.length ? " · No schedules saved" : ""}`,
            items: [
              ...routines.map((item) => ({
                at: item.nextAt, value: `routine:${item.id}`, label: item.title,
                description: item.paused ? `Paused · ${item.cron} · ${item.timezone}` : `Next ${local(item.nextAt, item.timezone)}`,
                body: `Recurring routine: ${item.id}\nStatus: ${item.paused ? "Paused" : "Enabled"}\nCron: ${item.cron}\nTimezone: ${item.timezone}\nNext run: ${local(item.nextAt, item.timezone)}\nNext run (UTC): ${utc(item.nextAt)}\nLast run: ${local(item.lastRunAt, item.timezone)}\nLast result: ${item.lastStatus}\nConversation: ${item.conversationId}\nTask: ${item.taskId ?? "None"}\n\n${item.instructions}`,
              })),
              ...reminders.map((item) => ({
                at: item.wakeAt, value: `reminder:${item.id}`, label: item.title,
                description: `Reminder · ${item.status} · ${local(item.wakeAt, config.timezone)}`,
                body: `One-time reminder: ${item.id}\nStatus: ${item.status}\nWake: ${local(item.wakeAt, config.timezone)}\nWake (UTC): ${utc(item.wakeAt)}\nDue (UTC): ${utc(item.dueAt)}\nSource: ${item.source}\nTask: ${item.wakeTaskId ?? "None"}\n\n${item.nextAction}`,
              })),
            ].sort((left, right) => (left.at ?? Infinity) - (right.at ?? Infinity))
              .map(({ at, ...item }) => item),
          };
        }
        if (kind === "skills") {
          const skills = await assistant.skills();
          return {
            title: "Skills",
            description: `${skills.filter((skill) => skill.readable).length} available · summaries advertised; full files read on demand`,
            items: skills.map((skill) => ({
              value: skill.path, label: skill.name,
              description: skill.readable ? skill.description : "SKILL.md is missing or unreadable",
              body: `${skill.path}\n\n${skill.readable ? skill.content : "Cannot read this skill file."}`,
            })),
          };
        }
        const { memories } = await assistant.personalState();
        const included = new Set(memories.filter((memory) => memory.pinned).slice(-PINNED_MEMORY_LIMIT).map((memory) => memory.key));
        const profile = await readFile(join(assistant.workspace, "USER.md"), "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
        return {
          title: "Memory",
          description: `${memories.length} saved · ${included.size} included on next request · shared across sessions`,
          items: [{
            value: "profile", label: "User profile", description: `USER.md · ${Math.min(profile.trim() ? profile.length : 0, USER_PROFILE_MAX_CHARS)} characters included`,
            body: `USER.md\n\nThe first ${USER_PROFILE_MAX_CHARS.toLocaleString("en-US")} characters are included on each request. This view shows the full file.\n\n${profile || "No profile saved."}`,
          }, ...memories.map((memory) => ({
            value: `memory:${memory.key}`, label: memory.key,
            description: included.has(memory.key) ? "Pinned · included on next request" : memory.pinned ? `Pinned · outside the last ${PINNED_MEMORY_LIMIT} pinned memories` : "Stored · retrieved on demand",
            body: `Key: ${memory.key}\nPinned: ${memory.pinned ? "yes" : "no"}\nIncluded on next request: ${included.has(memory.key) ? "yes" : "no"}\nSource: ${memory.source}\nUpdated: ${new Date(memory.updatedAt).toISOString()}\n\n${memory.text}`,
          }))],
        };
      } catch (error) { report(error); return undefined; }
    },
    switchConversation: (id) => guard(async () => {
      await stopVoice();
      if (!source.current().conversations.some((item) => item.id === id))
        throw new Error("Conversation is not configured.");
      const next = await assistant.harness.conversation(id, context);
      if (!next) throw new Error("Conversation is missing.");
      if (id === assistant.root.id || sessions.value?.conversations.includes(id)) {
        await assistant.root.commit(async (tx) => { (await tx.doc(TuiSessions)).active = id; }, context);
      }
      const view = await next.viewState(context);
      stopConversation();
      conversation.dispose();
      selected = next;
      conversation = view;
      stopConversation = conversation.subscribe(changed);
      changed();
    }),
  };
  let stopConversation = conversation.subscribe(changed);
  const stopTopics = topics.subscribe(changed);
  const stopSessions = sessions.subscribe(changed);
  const stopTasks = tasks.subscribe(changed);
  return {
    source,
    controller,
    notice,
    async dispose() {
      stopConversation();
      stopTasks();
      stopTopics();
      stopSessions();
      conversation.dispose();
      tasks.dispose();
      topics.dispose();
      sessions.dispose();
      listeners.clear();
      await stopVoice();
    },
  };
}
