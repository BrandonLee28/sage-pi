import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import {
  AssistantEntry,
  AgentDoc,
  createRegistry,
  configure,
  defineDoc,
  defineEntry,
  defineExtension,
  defineTask,
  GenerationTask,
  Harness,
  LiveDoc,
  hook,
  section,
  type Conversation,
  type ConversationId,
  type SubmissionId,
  type TaskId,
} from "@earendil-works/pi-durable";
import {
  createCodingTools,
  createReadTool,
  createWriteTool,
  createEditTool,
} from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { localModels } from "./model.ts";
import { personalExtension, personalState } from "./personal.ts";
import { webExtension } from "./web.ts";
import { calendarExtension } from "../extensions/calendar.ts";
import { routinesExtension } from "../extensions/routines.ts";
import { connectMcp } from "../extensions/mcp.ts";
import type { Config } from "./config.ts";

export const context = BACKGROUND_CONTEXT;
export const USER_PROFILE_MAX_CHARS = 2000;
async function readSkills(workspace: string) {
  const folders = await readdir(join(workspace, "skills"), { withFileTypes: true });
  return Promise.all(folders.filter((folder) => folder.isDirectory()).map(async (folder) => {
    const path = `skills/${folder.name}/SKILL.md`;
    let readable = true;
    const content = await readFile(join(workspace, path), "utf8").catch(() => { readable = false; return ""; });
    return { name: folder.name, path, content, readable, description: content.match(/^description:\s*(.+)$/m)?.[1] ?? "" };
  }));
}
const ModelChoice = defineDoc<{ revision: string | null }>({
  kind: "sage.model-choice", version: 1, scope: "conversation",
  history: "latest", fork: "current", initial: () => ({ revision: null }),
});
const ScheduledInput = defineEntry<{ requestId: string; telegram?: boolean }>("personal.scheduled");
const TELEGRAM_REWRITE = "Rewrite your last answer as a plain-text Telegram message. " +
  "Keep the same facts, times, names, and useful details. Remove Markdown formatting and raw JSON; " +
  "use short natural sentences or one plain line per schedule item. " +
  "Do not add slang, an unsolicited offer, or a follow-up question. " +
  "This is a wording correction only: do not repeat tools or actions, and do not invent file delivery.";
const TELEGRAM_SHORTEN = TELEGRAM_REWRITE +
  " The draft is too much for an ordinary text. Default to 1–3 short sentences, usually under 60 words. " +
  "Keep only the direct answer, decision-critical facts or constraints, and at most one useful next step. " +
  "Remove the full recap, repeated schedule, extra alternatives, and repeated conclusion. " +
  "If the original user explicitly asked for detail, a full plan, or a complete list, keep the requested content " +
  "and shorten only the surrounding commentary. Do not cut off sentences or change facts.";
const DeliveryIndex = defineDoc<{ tasks: Record<string, TaskId> }>({
  kind: "personal.deliveries",
  version: 1,
  scope: "session",
  initial: () => ({ tasks: {} }),
});
export const TelegramTopics = defineDoc<{ conversations: Record<string, ConversationId> }>({
  kind: "personal.telegram-topics",
  version: 1,
  scope: "session",
  initial: () => ({ conversations: {} }),
});
export const TuiSessions = defineDoc<{ conversations: ConversationId[]; active: ConversationId | null }>({
  kind: "sage.tui-sessions", version: 1, scope: "session",
  initial: () => ({ conversations: [], active: null }),
});
const TelegramRoute = defineDoc<{ threadId: number | null }>({
  kind: "personal.telegram-route",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ threadId: null }),
});

export async function openAssistant(
  config: Config,
  options: {
    models?: Models;
    model?: { provider: string; modelId: string };
    sendTelegram?: (text: string, threadId?: number) => Promise<void>;
  } = {},
) {
  const workspace = join(config.dataDir, "workspace");
  await mkdir(workspace, { recursive: true });
  await cp(new URL("../instructions/", import.meta.url), workspace, {
    recursive: true,
    force: false,
  });
  const models = options.models ?? await localModels(config);
  const advertised = models.getModels()[0];
  const defaultModel = options.model ?? (models.getModel("local", config.modelId)
    ? { provider: "local", modelId: config.modelId }
    : advertised ? { provider: advertised.provider, modelId: advertised.id } : undefined);
  if (!defaultModel) throw new Error("No model is available from llama.cpp.");
  const registry = createRegistry();
  let harness: Harness;
  let root: Conversation;

  async function isTelegramReply(conversationId: ConversationId, callContext: typeof context) {
    if (!options.sendTelegram) return false;
    const live = await harness.snapshot(LiveDoc, conversationId, callContext);
    // Follow the active run, not a conversation-wide flag: main and topics can also receive TUI input.
    for (const id of live?.run?.inputs ?? []) {
      const submission = await harness.submission(id, callContext);
      const status = await submission?.status(callContext);
      if (!status?.entry) continue;
      const entryId = status.entry;
      const entry = await harness.commit((tx) => tx.entry(entryId), callContext);
      if (entry?.kind === "personal.telegram" ||
          (ScheduledInput.is(entry) && entry.data?.telegram === true)) return true;
    }
    return false;
  }

  // Delivery is a native durable task, including its wait and retry checkpoints.
  const Delivery = defineTask<
    { submissionId: SubmissionId; threadId?: number },
    | { phase: "answer" }
    | {
        phase: "send";
        text: string;
        offset: number;
        attempt: number;
        retryAt: number;
      },
    null
  >({
    name: "personal.telegram-delivery",
    version: 1,
    initial: () => ({ phase: "answer" }),
    phases: {
      answer: async (task, runtime, callContext) => {
        const submission = await harness.submission(
          task.input.submissionId,
          callContext,
        );
        if (!submission)
          throw new Error("Missing submission for Telegram delivery");
        const settled = await submission.wait(callContext);
        let text =
          "The agent could not complete that request. Check the terminal for details.";
        if (settled.status === "done" && settled.type === "input") {
          const entry = await runtime.entry(
            AssistantEntry,
            settled.answer,
            callContext,
          );
          text = (entry?.model ?? [])
            .flatMap((message) =>
              message.role === "assistant"
                ? message.content.flatMap((part) =>
                    part.type === "text" ? [part.text] : [],
                  )
                : [],
            )
            .join("\n");
          if (!text.trim()) {
            const limited = entry?.model?.some((message) => message.role === "assistant" && message.stopReason === "length");
            text = limited
              ? "I hit the response limit before producing an answer. Your request isn't finished. Please ask me to handle one part at a time."
              : "The model finished without producing an answer. Your request isn't finished. Please try again.";
          }
        }
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: {
              phase: "send",
              text,
              offset: 0,
              attempt: 0,
              retryAt: 0,
            },
          }),
          callContext,
        );
      },
      send: async (task, runtime, callContext) => {
        const saved = task.state.checkpoint;
        if (!options.sendTelegram) {
          // Keep configured but temporarily unavailable delivery pending across restarts.
          await runtime.sleep(runtime.now() + 60000, callContext);
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: { ...saved, attempt: saved.attempt + 1 },
            }),
            callContext,
          );
          return;
        }
        if (saved.offset >= saved.text.length) {
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: null },
            }),
            callContext,
          );
          return;
        }
        try {
          await runtime.sleep(saved.retryAt, callContext);
          // ponytail: Telegram has no idempotency key; a crash after send can duplicate the last chunk.
          const chunk = saved.text.slice(saved.offset, saved.offset + 3500);
          await options.sendTelegram(chunk, task.input.threadId);
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: {
                ...saved,
                offset: saved.offset + chunk.length,
                attempt: 0,
              },
            }),
            callContext,
          );
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          if (saved.attempt >= 5) throw error;
          console.error(
            "Telegram delivery failed; retry scheduled:",
            error instanceof Error ? error.message : "unknown error",
          );
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: {
                ...saved,
                attempt: saved.attempt + 1,
                retryAt: runtime.now() + 5000 * 2 ** saved.attempt,
              },
            }),
            callContext,
          );
        }
      },
    },
    abort: (_task, runtime, callContext) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        callContext,
      ),
  });

  async function submit(
    content: string,
    requestId: string = randomUUID(),
    notify = false,
    steer = true,
    conversation = root,
  ) {
    const submission = await conversation.submit(
      {
        type: "input",
        content,
        requestId,
        ...(steer ? { whenBusy: "steer" as const } : {}),
        ...(!steer
          ? { entry: { kind: "personal.scheduled", data: { requestId, telegram: notify } } }
          : notify ? { entry: { kind: "personal.telegram" } } : {}),
      },
      context,
    );
    if (notify && options.sendTelegram)
      await conversation.commit(async (tx) => {
        const index = await tx.doc(DeliveryIndex);
        if (!index.tasks[String(submission.id)]) {
          const route = await tx.doc(TelegramRoute, conversation.id);
          index.tasks[String(submission.id)] = await tx.createTask(
            Delivery,
            {
              submissionId: submission.id,
              ...(route.threadId == null ? {} : { threadId: route.threadId }),
            },
            {
              ownership: { kind: "conversation" },
              background: true,
            },
          );
        }
      }, context);
    return submission;
  }

  const personal = personalExtension({
    timezone: config.timezone,
    submit: async (content, requestId, notify, conversationId) => {
      const conversation = await harness.conversation(conversationId, context);
      if (!conversation) throw new Error("Missing scheduled conversation");
      return submit(content, requestId, notify, false, conversation);
    },
  });
  const images = await createNodePhotonImages();
  registry.install(
    config.enableShell
      ? createCodingTools({ images })
      : defineExtension({
          name: "coding-tools",
          tools: [createReadTool({ images }), createWriteTool(), createEditTool()],
        }),
  );
  registry.install(personal.extension);
  registry.install(defineExtension({ name: "delivery", tasks: [Delivery] }));
  registry.install(
    defineExtension({
      name: "instructions",
      sections: [
        section("soul", () =>
          readFile(join(workspace, "SOUL.md"), "utf8"),
        ),
        section("user_profile", async () => {
          const profile = await readFile(join(workspace, "USER.md"), "utf8")
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return "";
              throw error;
            });
          if (!profile.trim()) return undefined;
          // Bound always-loaded context; the native read tool can open the full file.
          const content = profile.length <= USER_PROFILE_MAX_CHARS ? profile
            : profile.slice(0, USER_PROFILE_MAX_CHARS) +
              "\n[USER.md truncated to 2,000 characters. Read USER.md only if more detail is needed.]";
          return "Profile file: USER.md (shared across conversations). Update this file only when the user asks.\n\n" + content;
        }),
        section("instructions_file", () =>
          readFile(join(workspace, "AGENTS.md"), "utf8"),
        ),
        section("telegram_reply_style", async ({ conversationId }, callContext) =>
          await isTelegramReply(conversationId, callContext)
            ? readFile(join(workspace, "TELEGRAM.md"), "utf8") : undefined),
        section("telegram_brevity", async ({ conversationId }, callContext) =>
          await isTelegramReply(conversationId, callContext)
            ? readFile(join(workspace, "TELEGRAM-BREVITY.md"), "utf8") : undefined),
        section("skills", async () => {
          const skills = await readSkills(workspace);
          return `Read a relevant SKILL.md before using it. Skills are maintained by the user. Do not create, edit, or delete skills unless the user explicitly asks.\n${skills.map((skill) => `${skill.path}: ${skill.description}`).join("\n")}`;
        }),
      ],
      hooks: options.sendTelegram ? [hook(GenerationTask, {
        beforeRequest: async (request, api, callContext) => {
          if (!await isTelegramReply(api.conversationId, callContext)) return;
          const content = request.messages.findLast((message) => message.role === "user")?.content;
          if (content !== TELEGRAM_REWRITE && content !== TELEGRAM_SHORTEN) return;
          // This request may only reword the completed answer; it cannot repeat an external action.
          return { messages: [...request.messages, {
            role: "system", content: "Reword the answer only. Tools are unavailable for this correction.",
            toolsRemoved: getCurrentTools(request.messages).map(({ name }) => ({ name })), timestamp: Date.now(),
          }] };
        },
        onYield: async (answer, api, callContext) => {
          if (!await isTelegramReply(api.conversationId, callContext)) return;
          const text = answer.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
          let structured = false;
          try { const value = JSON.parse(text); structured = value !== null && typeof value === "object"; }
          catch { /* Ordinary conversation is not JSON. */ }
          const verbose = text.trim().split(/\s+/u).length > 80;
          if (!verbose && !structured && !/(?:\*\*[^*\n]+\*\*|```|^#{1,6} |\[[^\]\n]+\]\(https?:\/\/)/m.test(text)) return;
          const conversation = await harness.conversation(api.conversationId, callContext);
          if (!conversation) throw new Error("Missing conversation for Telegram style correction");
          const messages = (await conversation.context(callContext)).messages;
          const user = messages.findLast((message) => message.role === "user");
          const request = user?.role === "user" ? (typeof user.content === "string" ? user.content
            : user.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")) : "";
          // The native continuation starts a new generation task, so task-local memos cannot bound this retry.
          if (request === TELEGRAM_REWRITE || request === TELEGRAM_SHORTEN) return;
          // Honor explicit inline format requests; merely asking to save a JSON/Markdown file is not an opt-out.
          if (/\b(?:reply|respond|answer|return)\b[^\n]{0,60}\b(?:json|markdown|code)\b|\b(?:json|markdown|code)\b[^\n]{0,40}\b(?:inline|in (?:the )?chat)\b/i.test(request)) return;
          return { continue: verbose ? TELEGRAM_SHORTEN : TELEGRAM_REWRITE };
        },
      })] : [],
    }),
  );
  const web = webExtension(config);
  registry.install(web.extension);
  registry.install(calendarExtension(config));
  registry.install(routinesExtension({
    timezone: config.timezone,
    submit: async (content, requestId, conversationId) => {
      const conversation = await harness.conversation(conversationId, context);
      if (!conversation) throw new Error("Missing routine conversation");
      return submit(content, requestId, true, false, conversation);
    },
  }));
  const extensionDir = new URL("../extensions/", import.meta.url);
  for (const file of (await readdir(extensionDir))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
    .sort()) {
    const extension = (await import(new URL(file, extensionDir).href)).default;
    if (extension) registry.install(extension);
  }
  harness = await Harness.open(
    await openNodeSqliteStorage(join(config.dataDir, "agent.sqlite")),
    {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({
        cwd: cwd ?? workspace,
        shellEnv: {
          PATH: fileURLToPath(new URL("../node_modules/.bin", import.meta.url)) +
            delimiter + (process.env.PATH ?? ""),
          GOOGLE_WORKSPACE_CLI_CONFIG_DIR:
            process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR ?? join(config.dataDir, "google"),
        },
      }),
      settings: {
        // One conversation owns all inference, including follow-ups. No competing compaction stream.
        compaction: {
          backgroundTokens: 0,
          reserveTokens: Math.max(config.maxTokens + 1024, 4096),
          keepRecentTokens: 8192,
        },
        stream: { timeoutMs: 300000, maxRetries: 0 },
        retry: { maxRetries: 1, baseDelayMs: 3000 },
        progress: { partialIntervalMs: 250, outputIntervalMs: 250 },
        toolExecution: "sequential",
        steeringMode: "all",
      },
      onReport: (error) =>
        console.error(
          "[Pi]",
          error instanceof Error ? error.message : String(error),
        ),
    },
    context,
  );
  root = await harness.root(context);
  await root.commit(async (tx) => { await tx.doc(TelegramTopics); await tx.doc(TuiSessions); }, context);
  const topics = await harness.snapshot(TelegramTopics, context);
  const sessions = await harness.snapshot(TuiSessions, context);
  for (const id of [root.id, ...Object.values(topics?.conversations ?? {}), ...(sessions?.conversations ?? [])]) {
    const conversation = await harness.conversation(id, context);
    if (!conversation) throw new Error(`Missing conversation ${id}`);
    const saved = await harness.snapshot(AgentDoc, id, context);
    const choice = await harness.snapshot(ModelChoice, id, context);
    const changed = (choice?.revision ?? null) !== (config.modelRevision ?? null);
    await conversation.commit(async (tx) => {
      await configure(tx, id, {
        model: !changed && saved?.model && models.getModel(saved.model.provider, saved.model.modelId)
          ? saved.model : defaultModel,
        thinkingLevel: saved?.thinkingLevel ?? "low",
        cwd: workspace,
      });
      (await tx.doc(ModelChoice, id)).revision = config.modelRevision ?? null;
    }, context);
  }
  const mcp: Awaited<ReturnType<typeof connectMcp>>[] = [];
  for (const [name, server] of Object.entries(config.mcpServers)) {
    try {
      const connection = await connectMcp(name, server, workspace);
      const registered = new Set(registry.snapshot().tools().map(({ tool }) => tool.name));
      const collision = connection.extension.tools?.find((tool) => registered.has(tool.name));
      if (collision) {
        console.error(`[MCP] ${name} skipped: tool ${collision.name} is already registered. Rename this server with sage mcp and restart.`);
        await connection.close();
        continue;
      }
      mcp.push(connection);
      registry.install(connection.extension);
    } catch {
      console.error(`[MCP] ${name} unavailable. Run sage mcp test ${name} to diagnose, then restart.`);
    }
  }
  harness.resume();

  return {
    models,
    harness,
    root,
    submit,
    async createSession(from: ConversationId) {
      const saved = await harness.snapshot(AgentDoc, from, context);
      if (!saved?.model) throw new Error("The current session has no configured model.");
      return harness.createConversation({
        ownership: { kind: "ownerless" },
        agent: { model: saved.model, thinkingLevel: saved.thinkingLevel ?? "low", cwd: workspace },
        init: async (tx, id) => {
          const sessions = await tx.doc(TuiSessions);
          sessions.conversations.push(id);
          sessions.active = id;
          (await tx.doc(ModelChoice, id)).revision = config.modelRevision ?? null;
        },
      }, context);
    },
    async telegramConversation(threadId?: number) {
      if (threadId === undefined) return root;
      const id = await root.commit(async (tx) => {
        const topics = await tx.doc(TelegramTopics);
        if (!topics.conversations[String(threadId)]) {
          const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
          await configure(tx, created.id, {
            model: defaultModel,
            thinkingLevel: "low",
            cwd: workspace,
          });
          (await tx.doc(ModelChoice, created.id)).revision = config.modelRevision ?? null;
          const route = await tx.doc(TelegramRoute, created.id);
          route.threadId = threadId;
          topics.conversations[String(threadId)] = created.id;
        }
        return topics.conversations[String(threadId)]!;
      }, context);
      const conversation = await harness.conversation(id, context);
      if (!conversation) throw new Error("Missing Telegram conversation");
      return conversation;
    },
    registry,
    workspace,
    skills: () => readSkills(workspace),
    personalState: () => personalState(harness, context),
    async saveCommitment(value: Parameters<typeof personal.saveCommitment>[2]) {
      return root.commit(
        (tx) => personal.saveCommitment(tx, root.id, value, Date.now()),
        context,
      );
    },
    async close() {
      try { await harness.close(context); }
      finally {
        await Promise.allSettled(mcp.map((connection) => connection.close()));
        await web.close();
      }
    },
  };
}

export type Assistant = Awaited<ReturnType<typeof openAssistant>>;
