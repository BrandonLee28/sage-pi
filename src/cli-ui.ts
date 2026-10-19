import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  Input, ProcessTerminal, SelectList, TuiMainScreen,
  fuzzyFilter, getKeybindings, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth,
  type Component, type Focusable, type SelectItem,
} from "@earendil-works/pi-tui";
import {
  initTheme, loadThemeFromPath, setRegisteredThemes, theme,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const wordmark = [
  "█▀▀▀ ▄▀▀▄ █▀▀▀ █▀▀▀",
  "▀▀▀█ █▄▄█ █ ▀█ █▀▀ ",
  "▀▀▀▀ ▀  ▀ ▀▀▀▀ ▀▀▀▀",
];
const clean = (value: string) => stripTerminalSequences(value).replace(/[\x00-\x1f\x7f]/g, " ");

export function registerSageTheme() {
  setRegisteredThemes([loadThemeFromPath(fileURLToPath(new URL("../vendor/prime-design/sage.json", import.meta.url)))]);
  initTheme("sage");
}

export class SageHeader implements Component {
  details: { model?: string; cwd?: string; section?: string };
  constructor(details: SageHeader["details"] = {}) { this.details = details; }
  invalidate() {}
  render(width: number): string[] {
    const available = Math.max(1, width - 2);
    const logoWidth = Math.max(...wordmark.map(visibleWidth));
    const logo = available >= logoWidth + 3 + 28;
    const budget = logo ? available - logoWidth - 3 : available;
    let cwd = this.details.cwd;
    if (cwd === homedir() || cwd?.startsWith(homedir() + "/")) cwd = "~" + cwd.slice(homedir().length);
    const metadata = [
      theme.bold("sage") + theme.fg("dim", `  v${version}`),
      ...(this.details.section ? [theme.fg("muted", clean(this.details.section))] : []),
      ...(this.details.model ? [theme.fg("dim", "model ") + theme.fg("muted", clean(this.details.model))] : []),
      ...(cwd ? [theme.fg("dim", "cwd   ") + theme.fg("muted", clean(cwd))] : []),
    ];
    const count = Math.max(logo ? wordmark.length : 0, metadata.length);
    const offset = Math.floor((count - metadata.length) / 2);
    return ["", ...Array.from({ length: count }, (_, row) => {
      const left = logo ? theme.fg("text", (wordmark[row] ?? "").padEnd(logoWidth) + "   ") : "";
      return truncateToWidth(" " + left + truncateToWidth(metadata[row - offset] ?? "", budget), width);
    }), ""];
  }
}

/** Prime's menu grammar around Pi's native filtered list and input. */
export class SagePicker implements Component, Focusable {
  private input = new Input({ prompt: "> ", placeholder: "Type to filter…" });
  private list: SelectList;
  private title: string;
  private items: SelectItem[];
  private description: string;
  onSelect?: (value: string) => void;
  onCancel?: () => void;
  constructor(title: string, items: SelectItem[], description = "", selected?: string) {
    this.title = clean(title);
    this.items = items.map((item) => ({ ...item, label: clean(item.label), ...(item.description ? { description: clean(item.description) } : {}) }));
    this.description = clean(description);
    this.list = this.build(this.items);
    if (selected) this.list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === selected)));
  }
  get focused() { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  invalidate() { this.input.invalidate(); this.list.invalidate(); }
  private build(items: SelectItem[]) {
    const list = new SelectList(items, 6, {
      selectedPrefix: () => theme.fg("text", "› "),
      selectedText: (value) => theme.fg("text", theme.bold(value)),
      description: (value) => theme.fg("muted", value),
      scrollInfo: (value) => theme.fg("dim", value),
      noMatch: () => theme.fg("muted", "  No matches. Clear the filter to see all options."),
    }, { maxPrimaryColumnWidth: 36 });
    list.onSelect = (item) => this.onSelect?.(item.value);
    list.onCancel = () => this.onCancel?.();
    return list;
  }
  handleInput(data: string) {
    const bindings = getKeybindings();
    if (matchesKey(data, "ctrl+c")) return this.onCancel?.();
    if ((["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const).some((key) => bindings.matches(data, key))) {
      this.list.handleInput(data);
      return;
    }
    this.input.handleInput(data);
    const filtered = fuzzyFilter(this.items, this.input.getValue(), (item) => `${item.label} ${item.description ?? ""}`);
    this.list = this.build(filtered);
  }
  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const line = theme.fg("borderMuted", "─".repeat(inner));
    const rows = this.list.render(inner).map((row) => {
      const selected = /^[→›] /.test(stripTerminalSequences(row));
      if (selected) row = row.replace("→ ", "› ");
      const padded = row + " ".repeat(Math.max(0, inner - visibleWidth(row)));
      return " " + (selected ? theme.bg("selectedBg", padded) : theme.fg("muted", padded));
    });
    return [
      " " + theme.bold(this.title),
      ...(this.description ? [" " + theme.fg("muted", this.description)] : []), "",
      " " + line, ...this.input.render(inner).map((row) => " " + row), " " + line, "",
      ...rows, "", " " + theme.fg("dim", "↑↓ navigate · enter select · esc cancel"), "",
    ].map((row) => truncateToWidth(row, Math.max(1, width)));
  }
}

async function promptScreen(header: SageHeader, field: Component & Focusable, result: Promise<string | undefined>) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive setup needs a terminal. Run sage --help for direct commands.");
  const ui = new TuiMainScreen(new ProcessTerminal());
  ui.addChild(header);
  ui.addChild(field);
  ui.setFocus(field);
  try { ui.start(); return await result; }
  finally { ui.stop(); }
}

export async function selectOption(header: SageHeader, title: string, items: SelectItem[], description = "", selected?: string) {
  const picker = new SagePicker(title, items, description, selected);
  const result = new Promise<string | undefined>((resolve) => {
    picker.onSelect = resolve;
    picker.onCancel = () => resolve(undefined);
  });
  return promptScreen(header, picker, result);
}

export async function textPrompt(header: SageHeader, title: string) {
  const input = new Input({ prompt: "> " });
  const field: Component & Focusable = {
    get focused() { return input.focused; },
    set focused(value: boolean) { input.focused = value; },
    handleInput: (data) => matchesKey(data, "ctrl+c") ? input.onEscape?.() : input.handleInput(data),
    invalidate: () => input.invalidate(),
    render: (width) => {
      const inner = Math.max(1, width - 2);
      return [" " + theme.bold(clean(title)), "", ...input.render(inner).map((row) => " " + row), " " + theme.fg("borderMuted", "─".repeat(inner)), "", " " + theme.fg("dim", "enter continue · esc cancel"), ""].map((row) => truncateToWidth(row, Math.max(1, width)));
    },
  };
  const result = new Promise<string | undefined>((resolve) => {
    input.onSubmit = (value) => resolve(value.trim());
    input.onEscape = () => resolve(undefined);
  });
  return promptScreen(header, field, result);
}
