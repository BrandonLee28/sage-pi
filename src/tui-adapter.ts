import type {
  AgentState,
  ConversationView,
  ConversationId,
  ModelRef,
  TaskGraph,
} from "@earendil-works/pi-durable";
import { context, TelegramTopics, TuiSessions, USER_PROFILE_MAX_CHARS, type Assistant } from "./assistant.ts";
import { PINNED_MEMORY_LIMIT } from "./personal.ts";
import { Routines } from "../extensions/routines.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { scheduledTuiView } from "./scheduled-delivery.ts";

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

export async function tuiAdapter(assistant: Assistant, config: Config) {
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
  const source: DurableViewSource = {
    current: () => ({
      session: {
        id: "personal",
        directory: config.dataDir,
        cwd: assistant.workspace,
      },
      conversation: scheduledTuiView(conversation.value, Boolean(config.telegramToken)),
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
        if (text.trim() === "/new") return controller.newSession();
        if (text.trim() === "/help") {
          notice(
            "/new new session · /sessions saved chats · /skills, /memory, /schedules (/crons) read-only inspectors · /model · /tasks task graph · /compact [instructions] · Esc stop · Ctrl+O expand tools · Ctrl+C exit.",
          );
          return;
        }
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
    abort: () => guard(() => selected.abort(context)),
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
    dispose() {
      stopConversation();
      stopTasks();
      stopTopics();
      stopSessions();
      conversation.dispose();
      tasks.dispose();
      topics.dispose();
      sessions.dispose();
      listeners.clear();
    },
  };
}
