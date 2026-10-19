import type { Bot } from "grammy";
import type { Conversation, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const duration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

// One transient status message per active topic. Pi remains the source of execution state.
export function telegramProgress(bot: Bot, chat: string, conversation: Conversation, threadId?: number, initial = "Received") {
  const started = Date.now();
  let ended: number | undefined, finished: string | undefined;
  let view: Awaited<ReturnType<Conversation["viewState"]>> | undefined;
  let messageId: number | undefined, lastEntry = 0, completed = 0, failed = 0;
  let lastActivity = started, signature = "", lastText = "", pending = false;

  function activity() {
    const state = view?.value;
    const live = state?.docs["pi.live"] as LiveState | undefined;
    for (const entry of state?.entries ?? []) {
      if (entry.id <= lastEntry) continue;
      for (const message of entry.model ?? []) if (message.role === "toolResult") {
        completed++;
        if (message.isError) failed++;
      }
      lastEntry = Math.max(lastEntry, entry.id);
    }
    // Only sizes/statuses are used. Never send model reasoning, arguments, or outputs.
    const progress = JSON.stringify([lastEntry, live?.tools?.map((t) => [t.callId, t.status]),
      live?.generation?.message?.content.map((part) => part.type === "thinking" ? part.thinking.length :
        part.type === "text" ? part.text.length : part.type), live?.generation?.retry, live?.compactions]);
    if (progress !== signature) { signature = progress; lastActivity = Date.now(); }
    if (live?.compactions?.some((c) => c.blocking)) return "Compacting conversation";
    const tool = live?.tools?.find((t) => t.status === "running") ?? live?.tools?.find((t) => t.status === "pending");
    if (tool) {
      const labels: Record<string, string> = {
        calendar_read: "Reading calendar", calendar_write: "Updating calendar",
        web_search: "Searching the web", web_extract: "Reading a web page",
        document_read: "Reading a document", read: "Reading a file or photo",
        write: "Writing a file", edit: "Editing a file", bash: "Running a command",
        memory: "Using saved memory", recall: "Searching past conversations",
        commitment: "Updating a responsibility", routine: "Managing a routine",
      };
      return labels[tool.name] ?? `Running ${tool.name}`;
    }
    if (live?.generation?.retry) return "Retrying model request";
    const parts = live?.generation?.message?.content;
    if (parts?.at(-1)?.type === "text") return "Writing reply";
    if (parts?.length) return "Thinking";
    if (live?.generation || live?.run) return "Waiting for model";
    return initial;
  }
  function text() {
    const phase = activity();
    const lines = [`Sage · ${finished ?? phase}`, `${duration((ended ?? Date.now()) - started)} elapsed · ${completed} tool call${completed === 1 ? "" : "s"} finished${failed ? ` · ${failed} failed` : ""}`];
    if (!finished && Date.now() - lastActivity >= 20000) lines.push(`No new model/tool activity for ${duration(Date.now() - lastActivity)}.`);
    return lines.join("\n");
  }
  let chain = (async () => {
    view = await conversation.viewState(BACKGROUND_CONTEXT);
    lastEntry = view.value.entries.at(-1)?.id ?? 0;
    if (finished) return;
    lastText = text();
    const message = await bot.api.sendMessage(chat, lastText, {
      ...(threadId === undefined ? {} : { message_thread_id: threadId }), disable_notification: true,
    });
    messageId = message.message_id;
  })().catch(() => { /* Status failures must not prevent the actual answer. */ });
  async function paint() {
    if (messageId === undefined) return;
    const next = text();
    if (next === lastText) return;
    await bot.api.editMessageText(chat, messageId, next);
    lastText = next;
  }
  return {
    update() {
      if (finished || pending) return chain;
      pending = true;
      chain = chain.then(paint).catch(() => {}).finally(() => { pending = false; });
      return chain;
    },
    stop(label = "Reply ready") {
      if (finished) return chain;
      finished = label;
      ended = Date.now();
      chain = chain.then(paint).catch(() => {}).finally(() => { view?.dispose(); });
      return chain;
    },
  };
}
