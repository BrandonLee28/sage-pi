import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineDoc, defineExtension, section, type AgentState, type ConversationId } from "@earendil-works/pi-durable";

// Restore a temporary reasoning override on reopen; microphone sessions never resume after a crash.
export const VoiceMode = defineDoc<{ previousThinking: NonNullable<AgentState["thinkingLevel"]> | null }>({
  kind: "sage.voice-mode", version: 1, scope: "conversation",
  history: "latest", fork: "current", initial: () => ({ previousThinking: null }),
});

export function voiceExtension(workspace: string, active: (id: ConversationId) => boolean) {
  return defineExtension({ name: "voice", sections: [section("voice", async ({ conversationId }) =>
    active(conversationId) ? readFile(join(workspace, "VOICE.md"), "utf8") : undefined)] });
}
