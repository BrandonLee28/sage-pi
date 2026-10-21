import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { SageHeader, SagePicker, SageSecretInput, SageVoice, registerSageTheme } from "../src/cli-ui.ts";

registerSageTheme();

test("the native secret input accepts a token without rendering it", () => {
  const input = new SageSecretInput({ prompt: "> " });
  input.handleInput("disposable-token-that-must-not-be-rendered");
  for (const width of [1, 20, 80]) {
    const rows = input.render(width);
    assert.doesNotMatch(rows.join(""), /disposable|token/);
    assert.ok(rows.every((row) => visibleWidth(row) <= width));
  }
  let submitted = "";
  input.onSubmit = (value) => { submitted = value; };
  input.handleInput("\r");
  assert.equal(submitted, "disposable-token-that-must-not-be-rendered");
});

test("the voice orb reacts, animates, fits narrow screens, and stops when hidden", async () => {
  let repaints = 0;
  const orb = new SageVoice(() => { repaints++; });
  try {
    assert.deepEqual(orb.render(80), []);
    orb.update({ phase: "calibrating", level: 0, progress: .5 });
    assert.match(stripTerminalSequences(orb.render(80).join('\n')), /Calibrating.*stay quiet[\s\S]*1s/);
    orb.update({ phase: "hearing", level: .9 });
    const first = orb.render(80).join('\n');
    assert.match(stripTerminalSequences(first), /Hearing you[\s\S]*\|{10}/);
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.ok(repaints >= 1);
    assert.notEqual(orb.render(80).join('\n'), first);
    for (const width of [1, 20, 40, 80]) {
      for (const row of orb.render(width)) assert.ok(visibleWidth(row) <= width);
    }
    orb.update(undefined);
    assert.deepEqual(orb.render(80), []);
    const ended = repaints;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(repaints, ended);
  } finally { orb.dispose(); }
});

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

test("bottom command pickers fit their height and retain filtered selection on resize", () => {
  const picker = new SagePicker("Sessions", Array.from({ length: 20 }, (_, index) => ({ value: String(index), label: `Session ${index}` })), "Choose a saved chat", "15");
  let height = 12;
  let selected: string | undefined;
  picker.setHeight(() => height);
  picker.onSelect = (value) => { selected = value; };
  for (const nextHeight of [12, 9, 6, 12]) {
    height = nextHeight;
    const screen = picker.render(40);
    assert.ok(screen.length <= height);
    assert.match(stripTerminalSequences(screen.join("\n")), /› Session 15/);
    picker.handleInput("\r");
    assert.equal(selected, "15");
  }
  picker.handleInput("Session 19");
  height = 9;
  assert.match(stripTerminalSequences(picker.render(40).join("\n")), /› Session 19/);
  picker.handleInput("\r");
  assert.equal(selected, "19");
  const empty = new SagePicker("Schedules", []);
  empty.setHeight(() => height);
  assert.match(stripTerminalSequences(empty.render(40).join("\n")), /No entries available/);
});
