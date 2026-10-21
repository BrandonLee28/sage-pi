import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  Input, ProcessTerminal, SelectList, Text, TuiMainScreen,
  fuzzyFilter, getKeybindings, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth,
  type Component, type Focusable, type SelectItem,
} from "@earendil-works/pi-tui";
import { CustomEditor } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js";
import {
  initTheme, loadThemeFromPath, setRegisteredThemes, theme,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { VoiceStatus } from "./voice.ts";

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

/** Skin Pi's editor; native editing, cursor positions, history and completion stay intact. */
export class SageEditor extends CustomEditor {
  protected override renderTopBorder(width: number, hidden: number) {
    return super.renderTopBorder(width, hidden).replace(/─/g, " ");
  }
  protected override renderBottomBorder(width: number, hidden: number) {
    return super.renderBottomBorder(width, hidden).replace(/─/g, " ");
  }
  override render(width: number): string[] {
    const padding = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
    return super.render(width).map((original, index) => {
      let row = original;
      if (index === 1 && padding > 0) {
        row = theme.fg("muted", " > ".padEnd(padding).slice(0, padding)) + row.slice(padding);
        if (!this.getText() && width > 20) {
          row = row.trimEnd() + theme.fg("dim", "Ask Sage anything…");
          row = truncateToWidth(row, width);
          row += " ".repeat(Math.max(0, width - visibleWidth(row)));
        }
      }
      return theme.bg("userMessageBg", row);
    });
  }
}

export class SageFooter implements Component {
  model = "";
  thinking = "off";
  context = "";
  contextWarning = false;
  usage = "";
  invalidate() {}
  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const row = (left: string, right: string) => {
      right = truncateToWidth(right, inner);
      const remaining = inner - visibleWidth(right) - 2;
      left = remaining > 0 ? truncateToWidth(left, remaining) : "";
      const gap = " ".repeat(Math.max(0, inner - visibleWidth(left) - visibleWidth(right)));
      return truncateToWidth(" " + theme.fg("dim", left + gap + right), Math.max(1, width));
    };
    return [
      row("/ commands · shift+tab effort", `${clean(this.model)}:${clean(this.thinking)}${this.context ? " · " + (this.contextWarning ? theme.fg("error", clean(this.context)) : clean(this.context)) : ""}`),
      row("enter send · alt+enter queue · esc stop", clean(this.usage)),
    ];
  }
}

/** A transient terminal component. Animation never enters the conversation or runs inference. */
export class SageVoice implements Component {
  private status?: VoiceStatus;
  private timer?: ReturnType<typeof setInterval>;
  private frame = 0;
  private repaint: () => void;
  private height: () => number;
  constructor(repaint: () => void, height = () => 24) { this.repaint = repaint; this.height = height; }
  update(status?: VoiceStatus) {
    this.status = status;
    if (status && !this.timer) {
      this.timer = setInterval(() => { this.frame++; this.repaint(); }, 100);
      this.timer.unref();
    } else if (!status) this.dispose();
  }
  dispose() { clearInterval(this.timer); this.timer = undefined; this.status = undefined; }
  invalidate() {}
  render(width: number): string[] {
    const s = this.status;
    if (!s) return [];
    const labels = { loading: "Loading speech models", calibrating: "Calibrating · stay quiet",
      listening: "Listening", hearing: "Hearing you", transcribing: "Transcribing",
      thinking: "Thinking", speaking: "Speaking" };
    const energy = Math.max(0, Math.min(1, s.level));
    const bars = Math.round(energy * 12);
    const meter = "[" + "|".repeat(bars) + ".".repeat(12 - bars) + "]";
    const info = [theme.fg("accent", theme.bold("voice")) + "  " + theme.bold(labels[s.phase]),
      s.phase === "calibrating" ? `${Math.max(0, Math.ceil(2 * (1 - (s.progress ?? 0))))}s · measuring room noise`
        : s.phase === "loading" ? "Microphone opens after loading"
        : theme.fg("accent", meter) + theme.fg("dim", "  microphone"),
      theme.fg("dim", s.detail ?? "Echo cancellation · speak to interrupt"),
      theme.fg("dim", "/speak off · esc stop")];
    if (width < 38 || this.height() < 20) return info.slice(0, 3).map((line) => truncateToWidth(" " + line, Math.max(1, width)));
    const rows = this.height() >= 32 ? 9 : 7;
    const columns = rows * 2 + 5;
    const t = this.frame * .12;
    const active = s.phase === "hearing" ? energy : s.phase === "speaking" ? .45 : .08;
    const ramp = ".:-=+*#%@";
    return Array.from({ length: rows }, (_, y) => {
      let orb = "";
      for (let x = 0; x < columns; x++) {
        const nx = (x - (columns - 1) / 2) / ((columns - 2) / 2);
        const ny = (y - (rows - 1) / 2) / (rows / 2);
        const radius = Math.hypot(nx, ny);
        const edge = .94 + Math.sin(Math.atan2(ny, nx) * 3 + t * 2) * active * .1;
        if (radius > edge) { orb += " "; continue; }
        const z = Math.sqrt(Math.max(0, 1 - radius * radius));
        const cloud = Math.sin(nx * 3 + ny * 4 - t) * .16 + Math.cos(ny * 6 + t * 1.4) * .1;
        const shade = Math.max(0, Math.min(.999, .45 + z * .32 - nx * .2 - ny * .15 + cloud));
        const color = shade > .78 ? "text" : shade > .45 ? "accent" : "dim";
        orb += theme.fg(color, ramp[Math.floor(shade * ramp.length)]!);
      }
      return truncateToWidth(" " + orb + "   " + (info[y - 1] ?? ""), Math.max(1, width));
    });
  }
}

/** Plain text only: inspecting a memory or skill never executes or edits it. */
export class SageDetails implements Component, Focusable {
  focused = false;
  onBack?: () => void;
  onClose?: () => void;
  private offset = 0;
  private pageSize = 1;
  private lineCount = 0;
  private title: string;
  private text: Text;
  private height: () => number;
  constructor(title: string, content: string, height: () => number) {
    this.title = clean(title);
    this.text = new Text(content.split("\n").map(clean).join("\n"), 1, 0);
    this.height = height;
  }
  invalidate() { this.text.invalidate(); }
  handleInput(data: string) {
    if (matchesKey(data, "escape")) return this.onBack?.();
    if (matchesKey(data, "ctrl+c")) return this.onClose?.();
    if (matchesKey(data, "up")) this.offset--;
    if (matchesKey(data, "down")) this.offset++;
    if (matchesKey(data, "pageUp")) this.offset -= this.pageSize;
    if (matchesKey(data, "pageDown")) this.offset += this.pageSize;
    if (matchesKey(data, "home")) this.offset = 0;
    if (matchesKey(data, "end")) this.offset = this.lineCount;
    this.offset = Math.max(0, Math.min(this.offset, this.lineCount - this.pageSize));
  }
  render(width: number): string[] {
    const rows = this.text.render(width);
    this.lineCount = rows.length;
    this.pageSize = Math.max(1, this.height() - 5);
    this.offset = Math.max(0, Math.min(this.offset, rows.length - this.pageSize));
    const lines = [
      " " + theme.bold(this.title) + theme.fg("dim", " · read only"),
      theme.fg("borderMuted", "─".repeat(Math.max(1, width))),
      ...rows.slice(this.offset, this.offset + this.pageSize), "",
      " " + theme.fg("dim", `${this.offset + 1}–${Math.min(rows.length, this.offset + this.pageSize)} / ${rows.length} · ↑↓ / PgUp/PgDn scroll · esc back · ctrl+c close`),
    ];
    return lines.map((line) => {
      const row = truncateToWidth(line, Math.max(1, width));
      return theme.bg("customMessageBg", row + " ".repeat(Math.max(0, width - visibleWidth(row))));
    });
  }
}

/** Prime's menu grammar around Pi's native filtered list and input. */
export class SagePicker implements Component, Focusable {
  private input = new Input({ prompt: "> ", placeholder: "Type to filter…" });
  private list: SelectList;
  private title: string;
  private items: SelectItem[];
  private description: string;
  private height?: () => number;
  private maxVisible = 6;
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
  setHeight(height: () => number) { this.height = height; }
  invalidate() { this.input.invalidate(); this.list.invalidate(); }
  private build(items: SelectItem[]) {
    const list = new SelectList(items, this.maxVisible, {
      selectedPrefix: () => theme.fg("text", "› "),
      selectedText: (value) => theme.fg("text", theme.bold(value)),
      description: (value) => theme.fg("muted", value),
      scrollInfo: (value) => theme.fg("dim", value),
      noMatch: () => theme.fg("muted", this.items.length ? "  No matches. Clear the filter to see all options." : "  No entries available."),
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
    const maxVisible = this.height ? Math.max(1, Math.min(6, this.height() - 5)) : 6;
    if (maxVisible !== this.maxVisible) {
      const selected = this.list.getSelectedItem()?.value;
      this.maxVisible = maxVisible;
      const items = fuzzyFilter(this.items, this.input.getValue(), (item) => `${item.label} ${item.description ?? ""}`);
      this.list = this.build(items);
      this.list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === selected)));
    }
    const inner = Math.max(1, width - 2);
    const line = theme.fg("borderMuted", "─".repeat(inner));
    const rows = this.list.render(inner).map((row) => {
      const selected = /^[→›] /.test(stripTerminalSequences(row));
      if (selected) row = row.replace("→ ", "› ");
      const padded = row + " ".repeat(Math.max(0, inner - visibleWidth(row)));
      return " " + (selected ? theme.bg("selectedBg", padded) : theme.fg("muted", padded));
    });
    const heading = [" " + theme.bold(this.title), ...(this.description ? [" " + theme.fg("muted", this.description)] : [])];
    if (this.height) return [
      ...heading, ...this.input.render(inner).map((row) => " " + row),
      ...rows, " " + theme.fg("dim", "↑↓ navigate · enter select · esc back"),
    ].map((row) => truncateToWidth(row, Math.max(1, width)));
    return [
      ...heading, "",
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

export class SageSecretInput extends Input {
  override render(width: number): string[] {
    return [truncateToWidth("> " + "•".repeat(Math.min(this.getValue().length, Math.max(0, width - 2))), Math.max(1, width))];
  }
}

export async function textPrompt(header: SageHeader, title: string, secret = false) {
  const input = secret ? new SageSecretInput({ prompt: "> " }) : new Input({ prompt: "> " });
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
