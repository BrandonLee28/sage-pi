import { defineEntry, type ConversationView } from "@earendil-works/pi-durable";

export const ScheduledInput = defineEntry<{
  requestId: string; telegram?: boolean; delivery?: "agent";
}>("personal.scheduled");

export const TELEGRAM_REWRITE = "Rewrite your last answer as a plain-text Telegram message. " +
  "Keep the same facts, times, names, and useful details. Remove Markdown formatting and raw JSON; " +
  "use short natural sentences or one plain line per schedule item. " +
  "Do not add slang, an unsolicited offer, or a follow-up question. " +
  "This is a wording correction only: do not repeat tools or actions, and do not invent file delivery.";
export const TELEGRAM_SHORTEN = TELEGRAM_REWRITE +
  " The draft is too much for an ordinary text. Default to 1–3 short sentences, usually under 60 words. " +
  "Keep only the direct answer, decision-critical facts or constraints, and at most one useful next step. " +
  "Remove the full recap, repeated schedule, extra alternatives, and repeated conclusion. " +
  "If the original user explicitly asked for detail, a full plan, or a complete list, keep the requested content " +
  "and shorten only the surrounding commentary. Do not cut off sentences or change facts.";
export const KEEP_TELEGRAM_ROUTE = " Keep [TELEGRAM] on its own first line so the scheduled update retains its phone destination.";
export const isTelegramCorrection = (text: unknown) => [TELEGRAM_REWRITE, TELEGRAM_SHORTEN,
  TELEGRAM_REWRITE + KEEP_TELEGRAM_ROUTE, TELEGRAM_SHORTEN + KEEP_TELEGRAM_ROUTE].includes(text as string);

export const SCHEDULED_DELIVERY = "Choose delivery for this scheduled run using the user's instructions and the result. " +
  "Start your final answer with [TUI] or [TELEGRAM] on its own line, followed by the update. " +
  "Use [TUI] for terminal-only updates; use [TELEGRAM] for useful proactive phone updates, including morning briefings, " +
  "when Telegram is configured or the user requested it. Preserve the original Telegram topic. " +
  "If there is nothing useful to report, reply with exactly [SILENT]. Never use [SILENT] to hide a failure or an unfinished request. " +
  "These markers control delivery only; they do not authorize extra actions. " +
  "Do not claim phone delivery succeeded; a durable task sends the final answer after this run finishes.";

export function scheduledReply(text: string, telegram: boolean) {
  const match = /^\s*\[(TUI|TELEGRAM|SILENT)\](?:\s+|$)/u.exec(text);
  return {
    channel: match?.[1] ?? (telegram ? "TELEGRAM" : "TUI"),
    text: match ? text.slice(match[0].length).trim() : text,
  };
}

// Presentation only: Pi retains the full transcript for recovery and inspection.
export function scheduledTuiView(view: ConversationView, telegram: boolean): ConversationView {
  let scheduled = false;
  let scheduledTelegram = telegram;
  const entries = view.entries.flatMap((entry) => {
    if (ScheduledInput.is(entry)) {
      scheduled = entry.data?.delivery === "agent";
      scheduledTelegram = entry.data?.telegram ?? telegram;
    }
    else if (entry.kind === "pi.reset" || entry.kind === "personal.telegram" ||
      (entry.kind === "pi.user" && !(entry.byTaskId !== undefined && isTelegramCorrection(entry.model?.[0]?.content)))) scheduled = false;
    if (!scheduled) return [entry];
    const message = entry.model?.[0];
    if (message?.role !== "assistant" || message.stopReason === "toolUse") return [];
    const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
    const reply = scheduledReply(text, scheduledTelegram);
    if (reply.channel !== "TUI") return [];
    return [{ ...entry, model: [{ ...message, content: [{ type: "text" as const, text: reply.text }] }] }];
  });
  if (!scheduled) return { ...view, entries };
  // Wait for the final route before displaying any scheduled output or tool progress.
  const { generation, tools, nestedTools, ...live } = view.docs["pi.live"] ?? {};
  return { ...view, entries, docs: { ...view.docs, "pi.live": live } };
}
