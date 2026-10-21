import { watchEvents, type Conversation } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { context, type Assistant } from "./assistant.ts";
import { SpokenPhrases } from "./voice.ts";

/** Observe Pi's committed stream. Never run a second model loop or speak thinking/tool arguments. */
export async function voiceReply(assistant: Assistant, conversation: Conversation, text: string,
  signal: AbortSignal, speak: (text: string) => void, firstText: () => void) {
  const stream = await watchEvents(assistant.harness, conversation.id, context);
  let phrases = new SpokenPhrases(), current = "", active = false, started = false;
  let blocks = new Map<number, string>();
  const completed = new Set<number>();
  const feed = (value: string, final = false) => {
    if (signal.aborted) return;
    if (!value.startsWith(current)) { phrases = new SpokenPhrases(); current = ""; }
    const delta = value.slice(current.length);
    current = value;
    if (delta.trim() && !started) { started = true; firstText(); }
    for (const phrase of phrases.push(delta, final)) speak(phrase);
  };
  const message = (value: AssistantMessage) => {
    blocks = new Map(value.content.map((part, index) => [index, part.type === "text" ? part.text : ""]));
    feed([...blocks.values()].join(""));
  };
  try {
    signal.throwIfAborted();
    const submission = await assistant.submit(text, undefined, false, true, conversation);
    stream.start(async (events) => {
      for (const event of events) {
        if (signal.aborted) return;
        if (event.type === "run_start") active = event.inputs.includes(submission.id);
        if (event.type === "snapshot") {
          active = event.run?.inputs.includes(submission.id) ?? false;
          if (active && event.generation?.message) message(event.generation.message);
        }
        if (!active) continue;
        if (event.type === "message_start" && event.message.role === "assistant") {
          phrases = new SpokenPhrases(); current = ""; message(event.message);
        }
        if (event.type === "message_update") {
          for (const change of event.changes) {
            if (change.type === "text_delta") blocks.set(change.contentIndex, (blocks.get(change.contentIndex) ?? "") + change.delta);
            else if ((change.type === "text_start" || change.type === "block") && change.block.type === "text") blocks.set(change.contentIndex, change.block.text);
            else if (change.type === "message") message(change.message);
          }
          feed([...blocks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join(""));
        }
        if (event.type === "message_end") {
          const answer = event.entry.model?.findLast((item) => item.role === "assistant");
          if (answer?.role === "assistant" && !["aborted", "error"].includes(answer.stopReason)) {
            feed(answer.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""), true);
            completed.add(event.entry.id);
          }
        }
      }
    });
    const result = await submission.wait(context);
    await stream.stop();
    if (signal.aborted) return;
    if (result.status !== "done" || result.type !== "input") throw new Error("Voice request stopped or failed; see the transcript.");
    // A very short answer can settle before the last event callback. Read its durable receipt once.
    if (!completed.has(result.answer)) {
      const entry = await conversation.commit((tx) => tx.entry(result.answer), context);
      const answer = entry?.model?.findLast((item) => item.role === "assistant");
      if (answer?.role === "assistant") feed(answer.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""), true);
    }
  } finally { await stream.stop(); }
}
