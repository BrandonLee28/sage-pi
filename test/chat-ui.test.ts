import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { SettingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js";
import { openAssistant, context } from "../src/assistant.ts";
import { readConfig } from "../src/config.ts";
import { tuiAdapter } from "../src/tui-adapter.ts";
import { SageDetails, SageEditor, SagePicker, registerSageTheme } from "../src/cli-ui.ts";
import { DurableTui, runDurableTui } from "../vendor/pi-durable-tui/tui.ts";

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
    let input = (_data: string) => {};
    const noop = () => {};
    const terminal: Terminal = {
      get columns() { return columns; }, get rows() { return rows; }, kittyProtocolActive: false,
      start: (onInput) => { input = onInput; }, stop: noop, drainInput: async () => {}, write: noop, moveBy: noop,
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
      for (const dimensions of [[80, 24], [40, 18], [80, 24]]) {
        [columns, rows] = dimensions as [number, number];
        view.apply({ ...adapter.source.current(), voice: { phase: "listening", level: .5 } });
        view.ui.renderNow(true);
        const screen = view.ui.getScreenLines().map(stripTerminalSequences);
        assert.match(screen.join('\n'), /voice.*Listening/);
        assert.match(screen.join('\n'), />\s+Ask Sage anything/);
        assert.match(screen.join('\n'), /sage/);
        assert.ok(screen.every((line) => visibleWidth(line) <= columns));
      }
      view.apply(adapter.source.current());
      assert.ok(editor instanceof SageEditor);
      editor.handleInput("/");
      await new Promise((resolve) => setImmediate(resolve));
      view.ui.renderNow(true);
      const completionScreen = view.ui.getScreenLines().map(stripTerminalSequences);
      assert.ok(completionScreen.findIndex((line) => line.includes("Inspect available skills")) > completionScreen.findIndex((line) => line.includes("Saved answer line 59")), completionScreen.join("\n"));
      assert.match(completionScreen.slice(-10).join("\n"), /Inspect available skills/);
      editor.handleInput("\x1b");
      editor.setText("");
      editor.handleInput("/ex");
      await new Promise((resolve) => setImmediate(resolve));
      view.ui.renderNow(true);
      assert.match(view.ui.getScreenLines().map(stripTerminalSequences).join("\n"), /Exit Sage/);
      editor.handleInput("\x1b");
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
      const draft = editor.getText();
      view.showInspection({ title: "Skills", description: "Read-only test data", items: [{
        value: "test", label: "Test skill", description: "Inspect full contents",
        body: "\x1b]0;unsafe-title\x07\n" + Array.from({ length: 60 }, (_, index) => `OBSERVATION-ONLY line ${index}`).join("\n"),
      }] });
      const picker = view.ui.getFocusedComponent();
      assert.ok(picker instanceof SagePicker);
      view.ui.renderNow(true);
      const menuScreen = view.ui.getScreenLines().map(stripTerminalSequences);
      assert.ok(menuScreen.findIndex((line) => line.trim() === "Skills") > menuScreen.findIndex((line) => line.includes("Saved answer line 59")), menuScreen.join("\n"));
      assert.doesNotMatch(menuScreen.join("\n"), /line one|Ask Sage anything/);
      picker.handleInput("\r");
      const details = view.ui.getFocusedComponent();
      assert.ok(details instanceof SageDetails);
      for (const dimensions of [[80, 24], [40, 18], [80, 24]]) {
        [columns, rows] = dimensions as [number, number];
        view.ui.renderNow(true);
        const screen = view.ui.getScreenLines().map(stripTerminalSequences);
        const titleRow = screen.findIndex((line) => line.includes("Test skill · read only"));
        const answerRow = screen.findIndex((line) => line.includes("Saved answer line 59"));
        assert.ok(answerRow >= 6 && titleRow > answerRow, screen.join("\n"));
        assert.doesNotMatch(screen.slice(titleRow).join("\n"), /Saved answer|Ask Sage anything|line one/);
        assert.ok(screen.every((line) => visibleWidth(line) <= columns));
        assert.match(screen.at(-2)!, /commands/);
      }
      assert.doesNotMatch(view.ui.getScreenLines().join("\n"), /\x1b\]0;unsafe-title/);
      details.handleInput("\x1b[6~");
      view.ui.renderNow(true);
      details.handleInput("\x1b[F");
      view.ui.renderNow(true);
      assert.match(view.ui.getScreenLines().map(stripTerminalSequences).join("\n"), /OBSERVATION-ONLY line 59/);
      details.handleInput("\x1b");
      assert.equal(view.ui.getFocusedComponent(), picker);
      picker.handleInput("\x1b");
      assert.equal(view.ui.getFocusedComponent(), editor);
      assert.equal(editor.getText(), draft);
      assert.doesNotMatch(JSON.stringify(adapter.source.current().conversation.entries), /OBSERVATION-ONLY/);
    } finally { view.stop(); adapter.dispose(); }

    // Exercise the real editor's Enter/Alt+Enter command dispatch without model calls.
    const commands: string[] = [];
    const prompts: string[] = [];
    const uiAdapter = await tuiAdapter(assistant, config);
    const running = runDurableTui(uiAdapter.source, {
      ...uiAdapter.controller,
      newSession: async () => { commands.push("new"); },
      toggleTasks: async () => { commands.push("tasks"); },
      inspect: async (kind) => { commands.push(kind); return { title: kind, description: "Test inspector", items: [] }; },
      submit: async (text, mode) => { prompts.push(`${mode}:${text}`); },
    }, SettingsManager.inMemory(), terminal);
    try {
      for (const send of ["\r", "\x1b\r"]) {
        for (const command of ["/new", "/tasks", "/skills", "/memory", "/schedules", "/crons"]) {
          input(command);
          // Let Pi's native completion settle before confirming the command.
          await new Promise((resolve) => setImmediate(resolve));
          input(send);
          await new Promise((resolve) => setImmediate(resolve));
          if (["/skills", "/memory", "/schedules", "/crons"].includes(command)) input("\x1b");
        }
        input("A plain prompt");
        input(send);
      }
      assert.deepEqual(commands, ["new", "tasks", "skills", "memory", "schedules", "schedules", "new", "tasks", "skills", "memory", "schedules", "schedules"]);
      assert.deepEqual(prompts, ["steer:A plain prompt", "followUp:A plain prompt"]);
    } finally { input("\x04"); await running; uiAdapter.dispose(); }

    for (const send of ["\r", "\x1b\r"]) {
      const exitAdapter = await tuiAdapter(assistant, config);
      let terminalStopped = false;
      const exiting = runDurableTui(exitAdapter.source, {
        ...exitAdapter.controller,
        submit: async () => { assert.fail("/exit must not reach the model"); },
      }, SettingsManager.inMemory(), { ...terminal, stop: () => { terminalStopped = true; } });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        input("/exit");
        await new Promise((resolve) => setImmediate(resolve));
        input(send);
        await Promise.race([exiting, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("/exit did not close the TUI")), 1000);
        })]);
        assert.equal(terminalStopped, true);
      } finally {
        clearTimeout(timeout);
        input("\x04");
        await exiting;
        await exitAdapter.dispose();
      }
    }
  } finally { await assistant.close(); await rm(dataDir, { recursive: true, force: true }); }
});
