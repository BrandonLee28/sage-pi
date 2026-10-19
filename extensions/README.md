# Add a tool without building a plugin framework

Create a `.ts` file here. Export an ordinary Pi Durable extension as `default`.
Restart the agent to load it. The harness installs default exports from `.ts` files
in this folder. Named exports can also be assembled directly in `src/assistant.ts`;
`calendar.ts` uses this for the application's configured iCloud credentials.
See the official [extensions and tools documentation](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#extensions).

```ts
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export default defineExtension({
  name: "example",
  tools: [
    defineTool({
      name: "echo",
      description: "Return some text.",
      parameters: Type.Object({ text: Type.String() }),
      replay: "safe", // Only when repeating the operation after a crash is safe.
      execute: async ({ text }) => ({ output: [{ type: "text", text }] }),
    }),
  ],
});
```

For behavior changes, edit `data/workspace/AGENTS.md` or add a skill under
`data/workspace/skills/<name>/SKILL.md`. These are read on the next model request.
The `instructions/` files are first-run templates; they never overwrite your edits.
