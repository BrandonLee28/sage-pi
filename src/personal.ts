import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTool,
  defineTask,
  section,
  ROOT_CONVERSATION_ID,
  type Conversation,
  type DocumentReader,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";

export type Memory = {
  key: string;
  text: string;
  source: string;
  updatedAt: number;
  pinned: boolean;
};
export const PINNED_MEMORY_LIMIT = 8;
export type Commitment = {
  id: string;
  title: string;
  nextAction: string;
  source: string;
  status: string;
  dueAt: number | null;
  wakeAt: number | null;
  wakeTaskId: TaskId | null;
  updatedAt: number;
};

// Separate, versioned Pi documents; the index contains identifiers, not the memories themselves.
export const MemoryRecords = defineDocFamily<Memory, Memory>({
  kind: "personal.memory",
  version: 1,
  scope: "conversation",
  family: true,
  history: "rewindable",
  fork: "asOf",
  initial: (seed) => seed,
});
export const Commitments = defineDocFamily<Commitment, Commitment>({
  kind: "personal.commitment",
  version: 1,
  scope: "conversation",
  family: true,
  history: "rewindable",
  fork: "asOf",
  initial: (seed) => seed,
});
export const Index = defineDoc<{ memories: string[]; commitments: string[] }>({
  kind: "personal.index",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ memories: [], commitments: [] }),
});

export async function personalState(
  read: DocumentReader,
  context: Context,
) {
  // Keep existing documents on the root; all threads share this personal state.
  const conversationId = ROOT_CONVERSATION_ID;
  const index = await read.snapshot(Index, conversationId, context);
  const [memories, commitments] = await Promise.all([
    Promise.all(
      (index?.memories ?? []).map((key) =>
        read.snapshot(MemoryRecords, conversationId, key, context),
      ),
    ),
    Promise.all(
      (index?.commitments ?? []).map((key) =>
        read.snapshot(Commitments, conversationId, key, context),
      ),
    ),
  ]);
  return {
    memories: memories.filter((m): m is Memory => Boolean(m)),
    commitments: commitments.filter((m): m is Commitment => Boolean(m)),
  };
}

const text = (value: unknown) => ({
  output: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value),
    },
  ],
});
const Key = Type.String({ minLength: 1, maxLength: 160 });
const Text = Type.String({ minLength: 1, maxLength: 8000 });
const Status = Type.Union(
  ["open", "waiting", "blocked", "done", "cancelled"].map((value) =>
    Type.Literal(value),
  ),
);

export function personalExtension(options: {
  timezone: string;
  submit: (
    content: string,
    requestId: string,
    notify: boolean,
    conversationId: Conversation["id"],
  ) => Promise<unknown>;
}) {
  const Wake = defineTask<
    { id: string; at: number },
    { phase: "wait" } | { phase: "wake" },
    null
  >({
    name: "personal.wake",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (task, runtime, context) => {
        await runtime.sleep(task.input.at, context);
        await runtime.commit(
          () => ({ status: "running", checkpoint: { phase: "wake" } }),
          context,
        );
      },
      wake: async (task, runtime, context) => {
        const item = await runtime.snapshot(
          Commitments,
          ROOT_CONVERSATION_ID,
          task.input.id,
          context,
        );
        if (
          item?.wakeTaskId === task.id &&
          !["done", "cancelled"].includes(item.status)
        ) {
          await options.submit(
            `Scheduled check-in for commitment ${item.id}. Current time: ${new Date(runtime.now()).toISOString()}. ` +
              `Read its saved state, take the next useful action within the user's instructions, and give a concise update if useful. ` +
              `Record progress and schedule a next check with commitment if work remains. Do not invent progress or completion.`,
            `wake:${task.id}`,
            true,
            runtime.conversationId,
          );
        }
        await runtime.commit(async (tx) => {
          if (item?.wakeTaskId === task.id) {
            const current = await tx.doc(
              Commitments,
              ROOT_CONVERSATION_ID,
              task.input.id,
              item,
            );
            if (current.wakeTaskId === task.id) {
              current.wakeAt = null;
              current.wakeTaskId = null;
            }
          }
          return {
            status: "terminal",
            outcome: { status: "completed", result: null },
          };
        }, context);
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      ),
  });

  async function saveCommitment(
    tx: Tx,
    conversationId: Conversation["id"],
    value: {
      id: string;
      title?: string;
      nextAction?: string;
      source?: string;
      status?: string;
      dueAt?: string | null;
      wakeAt?: string | null;
    },
    now: number,
  ) {
    const parseDate = (date: string | null | undefined) => {
      // Some local models emit the JSON null sentinel as a string.
      if (date == null || date === "null") return null;
      if (
        !/(Z|[+-]\d\d:\d\d)$/.test(date) ||
        !Number.isFinite(Date.parse(date))
      ) {
        throw new Error(
          "Use an ISO 8601 timestamp with timezone offset, or null. Call clock if unsure.",
        );
      }
      return Date.parse(date);
    };
    const dueAt =
      value.dueAt === undefined ? undefined : parseDate(value.dueAt);
    const wakeAt =
      value.wakeAt === undefined ? undefined : parseDate(value.wakeAt);
    if (wakeAt != null && wakeAt <= now)
      throw new Error("wakeAt must be in the future.");
    const index = await tx.doc(Index, ROOT_CONVERSATION_ID);
    const exists = index.commitments.includes(value.id);
    if (!exists && !value.title)
      throw new Error("A new commitment requires title.");
    const item = await tx.doc(Commitments, ROOT_CONVERSATION_ID, value.id, {
      id: value.id,
      title: value.title ?? value.id,
      nextAction: "",
      source: "user",
      status: "open",
      dueAt: null,
      wakeAt: null,
      wakeTaskId: null,
      updatedAt: now,
    });
    for (const key of ["title", "nextAction", "source", "status"] as const) {
      if (value[key] !== undefined) item[key] = value[key]!;
    }
    if (dueAt !== undefined) item.dueAt = dueAt;
    if (wakeAt !== undefined && wakeAt !== item.wakeAt) {
      item.wakeAt = wakeAt;
      item.wakeTaskId =
        wakeAt === null
          ? null
          : await tx.createTask(
              Wake,
              { id: value.id, at: wakeAt },
              {
                conversationId,
                ownership: { kind: "conversation" },
                background: true,
              },
            );
    }
    if (["done", "cancelled"].includes(item.status)) {
      item.wakeAt = null;
      item.wakeTaskId = null;
    }
    item.updatedAt = now;
    if (!exists) index.commitments.push(value.id);
    return JSON.parse(JSON.stringify(item)) as Commitment;
  }

  const extension = defineExtension({
    name: "personal",
    tasks: [Wake],
    tools: [
      defineTool({
        name: "clock",
        description:
          "Get current time and configured timezone before scheduling relative dates.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async () =>
          text({
            iso: new Date().toISOString(),
            timezone: options.timezone,
            local: new Date().toLocaleString("en-US", {
              timeZone: options.timezone,
            }),
          }),
      }),
      defineTool({
        name: "memory",
        description:
          "Store, retrieve, correct, or forget long-term memories. Use stable keys and record the source. Only pin a few enduring preferences. Search before answering questions about earlier work.",
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("save"),
            Type.Literal("search"),
            Type.Literal("forget"),
          ]),
          key: Type.Optional(Key),
          text: Type.Optional(Text),
          query: Type.Optional(Type.String({ maxLength: 500 })),
          source: Type.Optional(Type.String({ maxLength: 1000 })),
          pinned: Type.Optional(Type.Boolean()),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          if (args.action === "search") {
            const state = await personalState(api, context);
            const words = (args.query ?? "")
              .toLowerCase()
              .split(/\s+/)
              .filter(Boolean);
            // ponytail: linear keyword retrieval; add an index when real recall tests justify it.
            return text(
              state.memories
                .filter((item) =>
                  words.every((w) =>
                    `${item.key} ${item.text} ${item.source}`
                      .toLowerCase()
                      .includes(w),
                  ),
                )
                .slice(-20),
            );
          }
          if (!args.key) throw new Error("key is required.");
          if (args.action === "save" && !args.text)
            throw new Error("text is required.");
          await api.commit(async (tx) => {
            const index = await tx.doc(Index, ROOT_CONVERSATION_ID);
            if (args.action === "forget") {
              if (index.memories.includes(args.key!)) {
                await tx.retireDoc(
                  MemoryRecords,
                  ROOT_CONVERSATION_ID,
                  args.key!,
                );
                index.memories.splice(index.memories.indexOf(args.key!), 1);
              }
            } else {
              const value = {
                key: args.key!,
                text: args.text!,
                source: args.source ?? "user",
                updatedAt: Date.now(),
                pinned: args.pinned ?? false,
              };
              Object.assign(
                await tx.doc(
                  MemoryRecords,
                  ROOT_CONVERSATION_ID,
                  args.key!,
                  value,
                ),
                value,
              );
              if (!index.memories.includes(args.key!))
                index.memories.push(args.key!);
            }
            await tx.appendEntry(api.conversationId, {
              kind: "personal.memory-change",
              data: { action: args.action, key: args.key! },
            });
          }, context);
          return text(`${args.action}: ${args.key}`);
        },
      }),
      defineTool({
        name: "commitment",
        description:
          "List or save persistent responsibilities, reminders, and progress. A due date alone does not schedule a wake: set wakeAt explicitly. Use null to clear a date. Reuse IDs to update. Completion requires evidence; answering the user does not finish the responsibility.",
        parameters: Type.Object({
          action: Type.Union([Type.Literal("list"), Type.Literal("save")]),
          id: Type.Optional(Key),
          title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
          nextAction: Type.Optional(Text),
          source: Type.Optional(Type.String({ maxLength: 1000 })),
          status: Type.Optional(Status),
          dueAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          wakeAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          if (args.action === "list")
            return text(
              (await personalState(api, context))
                .commitments,
            );
          if (!args.id) throw new Error("id is required.");
          return text(
            await api.commit(
              (tx) =>
                saveCommitment(
                  tx,
                  api.conversationId,
                  { ...args, id: args.id! },
                  Date.now(),
                ),
              context,
            ),
          );
        },
      }),
    ],
    sections: [
      section("personal_state", async (input, context) => {
        const state = await personalState(
          input.read,
          context,
        );
        return JSON.stringify({
          timezone: options.timezone,
          pinnedMemories: state.memories.filter((m) => m.pinned).slice(-PINNED_MEMORY_LIMIT),
          openCommitments: state.commitments
            .filter((c) => !["done", "cancelled"].includes(c.status))
            .slice(-25),
          otherMemoryCount: state.memories.filter((m) => !m.pinned).length,
        });
      }),
    ],
  });
  return { extension, saveCommitment };
}
