import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { openAssistant, context } from "../src/assistant.ts";
import { readConfig } from "../src/config.ts";
import { tuiAdapter } from "../src/tui-adapter.ts";
import { SageEditor, registerSageTheme } from "../src/cli-ui.ts";
import { DurableTui } from "../vendor/pi-durable-tui/tui.ts";

test("a reopened long chat keeps Sage's header and styled native editor visible", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sage-chat-ui-"));
  const config = { ...readConfig(), dataDir, mcpServers: {}, enableShell: false,
    telegramToken: "", telegramChat: "", searxngUrl: "", firecrawlUrl: "", lightpandaUrl: "", appleId: "", appleAppPassword: "", appleCalendarUrl: "" };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const open = () => openAssistant(config, { models, model: { provider: "faux", modelId: "faux-1" } });
  let assistant = await open();
  try {
    faux.setResponses([fauxAssistantMessage(Array.from({ length: 60 }, (_, index) => `Saved answer line ${index}`).join("\n\n"))]);
    await (await assistant.submit("Keep this saved chat.")).wait(context);
    await assistant.close();
    assistant = await open();
    const adapter = await tuiAdapter(assistant, config);
    let columns = 80, rows = 24;
    const noop = () => {};
    const terminal: Terminal = {
      get columns() { return columns; }, get rows() { return rows; }, kittyProtocolActive: false,
      start: noop, stop: noop, drainInput: async () => {}, write: noop, moveBy: noop,
      hideCursor: noop, showCursor: noop, clearLine: noop, clearFromCursor: noop,
      clearScreen: noop, setTitle: noop, setProgress: noop, setProgramStatus: noop,
    };
    registerSageTheme();
    const view = new DurableTui(assistant.workspace, { submit: noop, followUp: noop, abort: noop, exit: noop, selectModel: noop, cycleThinking: noop }, terminal);
    try {
      view.apply(adapter.source.current());
      view.start();
      for (const dimensions of [[80, 24], [40, 18], [80, 24]]) {
        [columns, rows] = dimensions as [number, number];
        view.ui.renderNow(true);
        const screen = view.ui.getScreenLines().map(stripTerminalSequences);
        assert.ok(screen.slice(0, 6).some((line) => line.includes("sage")), screen.join("\n"));
        assert.ok(screen.slice(0, 6).some((line) => line.includes("model faux-1")), screen.join("\n"));
        assert.match(screen.join("\n"), /Saved answer line 59/);
        assert.doesNotMatch(screen.join("\n"), /Saved answer line 0(?:\s|$)/);
        assert.match(screen.join("\n"), />\s+Ask Sage anything/);
        assert.ok(screen.every((line) => visibleWidth(line) <= columns));
      }
      const editor = view.ui.getFocusedComponent();
      assert.ok(editor instanceof SageEditor);
      editor.setText("A native editor draft");
      editor.focused = true;
      const rendered = editor.render(80);
      assert.ok(rendered.some((line) => line.includes(CURSOR_MARKER)));
      assert.match(rendered.join("\n"), /\x1b\[48/);
      assert.doesNotMatch(stripTerminalSequences(rendered.join("\n")), /─{3,}/);
      editor.handleInput("\x1b[D");
      editor.handleInput("!");
      assert.equal(editor.getText(), "A native editor draf!t");
      editor.setText("line one\nline two");
      assert.match(stripTerminalSequences(editor.render(40).join("\n")), /line one[\s\S]*line two/);
    } finally { view.stop(); adapter.dispose(); }
  } finally { await assistant.close(); await rm(dataDir, { recursive: true, force: true }); }
});
