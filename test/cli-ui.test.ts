import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { SageHeader, SagePicker, registerSageTheme } from "../src/cli-ui.ts";

registerSageTheme();

test("Sage's header and pickers fit narrow terminals and scrub supplied labels", () => {
  const header = new SageHeader({ model: "a-very-long-model-name-".repeat(5), cwd: "/workspace/".repeat(20), section: "Setup" });
  const picker = new SagePicker("Models", [
    { value: "first", label: "Model one", description: "Current model" },
    { value: "second", label: "\x1b]0;bad title\x07Model two", description: "Available\nnow" },
  ]);
  for (const width of [1, 20, 40, 80, 120]) {
    for (const row of [...header.render(width), ...picker.render(width)]) assert.ok(visibleWidth(row) <= width, `${visibleWidth(row)} > ${width}`);
  }
  assert.ok(header.render(80).some((row) => row.includes("█")));
  assert.ok(header.render(30).every((row) => !row.includes("█")));
  assert.doesNotMatch(picker.render(80).join("\n"), /\x1b\]0;|Available\nnow/);
});

test("Pi picker navigation, filtering, current selection, and cancellation work", () => {
  const picker = new SagePicker("Setup", [
    { value: "model", label: "Model", description: "Choose a model" },
    { value: "mcp", label: "MCP servers", description: "Manage tool connections" },
    { value: "doctor", label: "Diagnostics", description: "Check setup" },
  ], "", "mcp");
  let selected: string | undefined;
  let cancelled = 0;
  picker.onSelect = (value) => { selected = value; };
  picker.onCancel = () => { cancelled++; };
  picker.handleInput("\r");
  assert.equal(selected, "mcp");
  picker.handleInput("\x1b[B");
  picker.handleInput("\r");
  assert.equal(selected, "doctor");
  picker.handleInput("\x1b[A");
  picker.handleInput("\r");
  assert.equal(selected, "mcp");
  picker.handleInput("model");
  const rendered = picker.render(80);
  assert.match(stripTerminalSequences(rendered.join("\n")), /› Model/);
  assert.match(rendered.join("\n"), /\x1b\[(?:48|100)/);
  picker.handleInput("\r");
  assert.equal(selected, "model");
  picker.handleInput("no-match");
  assert.match(stripTerminalSequences(picker.render(80).join("\n")), /No matches/);
  picker.handleInput("\x1b");
  picker.handleInput("\x03");
  assert.equal(cancelled, 2);
});
