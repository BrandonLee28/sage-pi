// Upstream Pi v1.0.0 durable demo TUI. See README.md for provenance and adaptations.
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type {
	ConversationId,
	EntryRecord,
	InboxState,
	LiveState,
	TaskGraph,
	TaskGraphNode,
	UsageState,
} from "@earendil-works/pi-durable";
import {
	Box,
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Markdown,
	ProcessTerminal,
	ScrollView,
	type SelectItem,
	Spacer,
	setCapabilityOverrides,
	setKeybindings,
	Text,
	TruncatedText,
	TuiAltScreen,
	type Terminal,
	VStack,
} from "@earendil-works/pi-tui";
import { getAgentDir } from "../../node_modules/@earendil-works/pi-coding-agent/dist/config.js";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import type { SettingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js";
import { createAllToolRenderers } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/index.js";
import { AssistantMessageComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js";
import { formatTokens } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js";
import { keyText } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/keybinding-hints.js";
import { type StatusIndicator, WorkingStatusIndicator } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/status-indicator.js";
import { ToolExecutionComponent, type ToolRenderers } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { UserMessageComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js";
import { getEditorTheme, getMarkdownTheme, theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { InteractiveThemeController } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-controller.js";
import { SageDetails, SageEditor, SageFooter, SageHeader, SagePicker, registerSageTheme } from "../../src/cli-ui.ts";
import { agentOf, type DurableController, type DurableView, type DurableViewSource, type Inspection } from "../../src/tui-adapter.ts";

/** The summary that replaced earlier context: collapsed to one line until expanded. */
class CompactionComponent extends Box {
	readonly #summary: string;

	constructor(summary: string, expanded: boolean) {
		super(1, 1, (text) => theme.bg("customMessageBg", text));
		this.#summary = summary;
		this.setExpanded(expanded);
	}

	setExpanded(expanded: boolean): void {
		this.clear();
		this.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[compaction]")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			expanded
				? new Markdown(this.#summary, 0, 0, getMarkdownTheme(), {
						color: (text: string) => theme.fg("customMessageText", text),
					})
				: new Text(
						theme.fg("customMessageText", "Earlier context summarized (") +
							theme.fg("dim", keyText("app.tools.expand")) +
							theme.fg("customMessageText", " to expand)"),
						0,
						0,
					),
		);
	}
}

interface Handlers {
	submit(text: string): void;
	followUp(text: string): void;
	abort(): void;
	exit(): void;
	selectModel(): void;
	cycleThinking(): void;
}

export class DurableTui {
	static readonly #renderers: Record<string, ToolRenderers> = createAllToolRenderers();
	readonly #ui: TuiAltScreen;
	readonly #chat = new Container();
	readonly #header = new SageHeader();
	readonly #tasks = new Container();
	readonly #queue = new Container();
	readonly #notices = new Container();
	readonly #footer = new SageFooter();
	readonly #editorContainer = new Container();
	readonly #editor: SageEditor;
	readonly #cwd: string;
	/** The newest card per call ID; provider call IDs may repeat across turns. */
	readonly #tools = new Map<string, ToolExecutionComponent>();
	/** Every card shown, also older ones whose call ID a later turn reused. */
	readonly #cards: ToolExecutionComponent[] = [];
	/** Call IDs whose cards the streaming answer created; its entry takes them over. */
	readonly #streamingCalls = new Set<string>();
	readonly #summaries: CompactionComponent[] = [];
	/** Tool output and summaries shown in full; toggled like pi. */
	#expanded = false;
	#renderedEntryIds: number[] = [];
	#streaming: AssistantMessageComponent | undefined;
	#indicator: StatusIndicator | undefined;
	#statusText = "";
	/** Set when the transcript was rebuilt: the next render repaints the screen and shows the end. */
	#rebuilt = false;
	#transcript: ScrollView;

	constructor(cwd: string, handlers: Handlers, terminal: Terminal = new ProcessTerminal()) {
		this.#cwd = cwd;
		this.#ui = new TuiAltScreen(terminal, false, getAgentDir());
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		this.#editor = new SageEditor(this.#ui, getEditorTheme(), keybindings, {
			paddingX: 4,
			embedWorkingStatus: true,
		});
		this.#editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
			{ name: "speak", description: "Hands-free local voice; /speak off stops the microphone" },
			{ name: "skills", description: "Inspect available skills (read only)" },
			{ name: "memory", description: "Inspect saved memory and profile (read only)" },
			{ name: "schedules", description: "Inspect recurring routines and reminders (read only)" },
			{ name: "crons", description: "Alias for /schedules" },
			{ name: "new", description: "Start a fresh session" },
			{ name: "sessions", description: "New session or saved chats" },
			{ name: "model", description: "Choose a model" },
			{ name: "agents", description: "Switch conversation" },
			{ name: "compact", description: "Compact conversation context" },
			{ name: "tasks", description: "Show or hide background task details" },
			{ name: "help", description: "Show shortcuts" },
		], cwd));
		this.#editor.onSubmit = handlers.submit;
		this.#editor.onEscape = handlers.abort;
		this.#editor.onCtrlD = handlers.exit;
		this.#editor.onAction("app.clear", handlers.exit);
		this.#editor.onAction("app.model.select", handlers.selectModel);
		this.#editor.onAction("app.thinking.cycle", handlers.cycleThinking);
		this.#editor.onAction("app.tools.expand", () => {
			this.#expanded = !this.#expanded;
			for (const component of [...this.#cards, ...this.#summaries]) component.setExpanded(this.#expanded);
			this.#ui.requestRender();
		});
		this.#editor.onAction("app.message.followUp", () => {
			const text = this.#editor.getText().trim();
			if (!text) return;
			this.#editor.setText("");
			handlers.followUp(text);
		});

		this.#editorContainer.addChild(this.#editor);
		// One empty line between the transcript and everything below it.
		const content = new Container();
		content.addChild(this.#chat);
		content.addChild(new Spacer(1));
		const transcript = new ScrollView(content, { follow: "end", primary: true, overscroll: "chain" });
		this.#transcript = transcript;
		const dock = new VStack([
			{ component: this.#tasks, shrink: 1, minSize: 0 },
			{ component: this.#queue, shrink: 1, minSize: 0 },
			{ component: this.#notices, shrink: 1, minSize: 0 },
			{ component: this.#editorContainer, shrink: 1, minSize: 3 },
			{ component: this.#footer, shrink: 1, minSize: 0 },
		]);
		for (const component of [
			this.#header,
			this.#chat,
			this.#tasks,
			this.#queue,
			this.#notices,
			this.#editorContainer,
			this.#footer,
		]) {
			this.#ui.addChild(component);
		}
		this.#ui.setLayoutRoot(
			new VStack([
				{ component: this.#header, basis: "auto", shrink: 1, minSize: 0 },
				{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			]),
		);
		this.#ui.setFocus(this.#editor);
	}

	get ui(): TuiAltScreen {
		return this.#ui;
	}

	start(): void {
		this.#ui.start();
	}

	stop(): void {
		this.#discardTools();
		this.#indicator?.dispose();
		this.#ui.stop();
	}

	/** Finish every card: a running bash card keeps a timer until it gets a final result. */
	#discardTools(): void {
		for (const component of this.#cards) component.updateResult({ content: [], isError: false }, false);
		this.#cards.length = 0;
		this.#tools.clear();
		this.#streamingCalls.clear();
	}

	mount(component: Component): void {
		if (component instanceof SagePicker) component.setHeight(() => this.#panelHeight());
		this.#editorContainer.clear();
		this.#editorContainer.addChild(component);
		this.#ui.setFocus(component);
		this.#ui.requestRender();
	}

	restoreEditor(): void {
		this.mount(this.#editor);
	}

	#panelHeight(): number {
		return Math.max(6, Math.floor(this.#ui.terminal.rows / 2));
	}

	showInspection(data: Inspection): void {
		const picker = new SagePicker(data.title, data.items, data.description);
		picker.onCancel = () => this.restoreEditor();
		picker.onSelect = (value) => {
			const item = data.items.find((item) => item.value === value);
			if (!item) return;
			const details = new SageDetails(item.label, item.body, () => this.#panelHeight());
			details.onBack = () => this.mount(picker);
			details.onClose = () => this.restoreEditor();
			this.mount(details);
		};
		this.mount(picker);
	}

	apply(view: DurableView): void {
		const live = (view.conversation.docs["pi.live"] ?? {}) as LiveState;
		this.#syncTranscript(view.conversation.entries);
		const message = live.generation?.message as AssistantMessage | undefined;
		// A partial without its entry was dropped, for example by a retry: render the transcript again.
		if (message === undefined && this.#streaming !== undefined) this.#rebuild(view.conversation.entries);
		if (message !== undefined) this.#syncStreaming(message);
		for (const slot of live.tools ?? []) {
			if (slot.status === "pending") continue;
			const component = this.#tool(slot.name, slot.callId);
			component.setArgsComplete();
			if (slot.status !== "running") continue;
			component.markExecutionStarted();
			const child = (slot.details as { conversationId?: number } | undefined)?.conversationId;
			if (slot.output === undefined && child !== undefined) {
				const text = `Subagent ${child} is working. /agents switches to it.`;
				component.updateResult({ content: [{ type: "text", text }], details: slot.details, isError: false }, true);
			} else if (slot.output !== undefined) {
				component.updateResult(
					{ content: [{ type: "text", text: slot.output }], details: slot.details, isError: false },
					true,
				);
			}
		}
		this.#syncTasks(view.tasks);
		this.#syncQueue((view.conversation.docs["pi.inbox"] ?? { items: [] }) as InboxState);
		this.#syncNotices(view);
		this.#editor.borderColor = theme.getThinkingBorderColor(agentOf(view.conversation).thinkingLevel ?? "off");
		this.#syncStatus(live);
		this.#syncFooter(view);
		if (this.#rebuilt) this.#transcript.scrollToEnd();
		this.#ui.requestRender(this.#rebuilt);
		this.#rebuilt = false;
	}

	#syncTasks(graph: TaskGraph | undefined): void {
		this.#tasks.clear();
		if (graph === undefined) return;
		const nodes = Object.values(graph.tasks);
		if (!nodes.length) return;
		const lines: string[] = [theme.fg("accent", `Tasks (${nodes.length} live, /tasks to hide)`)];
		// A conversation-owned task sits under the task that owns its conversation, when that task is live.
		const owned = new Set(nodes.flatMap((node) => node.conversations));
		const children = (node: TaskGraphNode) =>
			nodes.filter(
				(candidate) =>
					candidate.owner === node.id ||
					(candidate.owner === undefined && node.conversations.includes(candidate.conversationId)),
			);
		const visit = (node: TaskGraphNode, depth: number): void => {
			lines.push(`${"  ".repeat(depth + 1)}${describeTask(node)}`);
			for (const child of children(node)) visit(child, depth + 1);
		};
		for (const node of nodes) {
			if (node.owner === undefined && !owned.has(node.conversationId)) visit(node, 0);
		}
		for (const line of lines) this.#tasks.addChild(new TruncatedText(theme.fg("muted", line), 1, 0));
	}

	#syncQueue(inbox: InboxState): void {
		this.#queue.clear();
		for (const item of inbox.items) {
			const text =
				item.mode === "write" ? `<${String(item.entry.kind)}>` : userText(item.content as UserMessage["content"]);
			this.#queue.addChild(new TruncatedText(theme.fg("muted", `[${item.mode}] ${text}`), 1, 0));
		}
	}

	#syncNotices(view: DurableView): void {
		this.#notices.clear();
		for (const item of view.notices.slice(-4)) {
			const color = item.level === "error" ? "error" : item.level === "warning" ? "warning" : "muted";
			this.#notices.addChild(new TruncatedText(theme.fg(color, item.message), 1, 0));
		}
	}

	#syncStatus(live: LiveState): void {
		const generation = live.generation;
		const compaction = live.compactions?.[0];
		const runningTool = live.tools?.find((slot) => slot.status === "running");
		let text = "";
		if (generation?.retry !== undefined) {
			text = `Retrying (attempt ${generation.attempt + 1}): ${generation.retry.error}`;
		} else if (generation?.deferred !== undefined) text = "Waiting for deferred response...";
		else if (compaction !== undefined) {
			text = compaction.retry
				? `Retrying ${compaction.reason} compaction (attempt ${compaction.attempt + 1})...`
				: `Compacting (${compaction.reason})...`;
		} else if (runningTool !== undefined) text = `Running ${runningTool.name}... (esc to abort)`;
		else if (live.run !== undefined) text = "Working... (esc to abort)";
		if (text === this.#statusText) return;
		this.#statusText = text;
		this.#indicator?.dispose();
		this.#indicator = text
			? new WorkingStatusIndicator(this.#ui, text, undefined, (part) => this.#editor.borderColor(part))
			: undefined;
		this.#editor.setWorkingStatusIndicator(this.#indicator);
	}

	#syncFooter(view: DurableView): void {
		const agent = agentOf(view.conversation);
		const usage = totalUsage((view.conversation.docs["pi.usage"] ?? { models: {}, tools: {} }) as UsageState);
		const stats: string[] = [];
		if (usage.input) stats.push(`↑${formatTokens(usage.input)}`);
		if (usage.output) stats.push(`↓${formatTokens(usage.output)}`);
		if (usage.cacheRead) stats.push(`R${formatTokens(usage.cacheRead)}`);
		if (usage.cacheWrite) stats.push(`W${formatTokens(usage.cacheWrite)}`);
		stats.push(`$${usage.cost.total.toFixed(3)}`);
		const contextWindow =
			view.models.find((model) => model.provider === agent.model?.provider && model.modelId === agent.model.modelId)
				?.contextWindow ?? 0;
		this.#footer.context = "";
		this.#footer.contextWarning = false;
		if (contextWindow > 0) {
			const tokens = contextTokens(view.conversation.entries);
			const percent = tokens === undefined ? undefined : (tokens / contextWindow) * 100;
			const text = `${percent === undefined ? "?" : percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
			this.#footer.context = text;
			this.#footer.contextWarning = percent !== undefined && percent > 90;
		}
		this.#footer.usage = stats.join("  ");
		this.#footer.model = agent.model?.modelId ?? "no model";
		this.#footer.thinking = agent.thinkingLevel ?? "off";
		const shown = view.conversations.find((candidate) => candidate.id === view.conversation.conversation.id);
		const label = shown?.label ?? `conversation ${view.conversation.conversation.id}`;
		this.#header.details = {
			section: `${label} · $${usage.cost.total.toFixed(3)}`,
			model: agent.model?.modelId,
			cwd: view.session.cwd,
		};
	}

	#syncTranscript(entries: readonly EntryRecord[]): void {
		// Compaction and resets replace the head of the active transcript.
		if (this.#renderedEntryIds.some((id, index) => entries[index]?.id !== id)) this.#rebuild(entries);
		for (const entry of entries.slice(this.#renderedEntryIds.length)) {
			this.#addEntry(entry);
			this.#renderedEntryIds.push(entry.id);
		}
	}

	#rebuild(entries: readonly EntryRecord[]): void {
		this.#chat.clear();
		this.#discardTools();
		this.#summaries.length = 0;
		this.#rebuilt = true;
		this.#renderedEntryIds = [];
		this.#streaming = undefined;
		for (const entry of entries) {
			this.#addEntry(entry);
			this.#renderedEntryIds.push(entry.id);
		}
	}

	#addEntry(entry: EntryRecord): void {
		const message = entry.model?.[0];
		if ((entry.kind === "pi.user" || entry.kind === "personal.telegram" || entry.kind === "personal.scheduled") && message?.role === "user") {
			this.#chat.addChild(new Spacer(1));
			this.#chat.addChild(new UserMessageComponent(userText(message.content)));
		} else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
			const component = this.#streaming ?? new AssistantMessageComponent();
			if (this.#streaming === undefined) this.#chat.addChild(component);
			this.#streaming = undefined;
			component.updateContent(message, false);
			// Only a tool-calling answer runs its calls; an aborted, failed, or truncated one never does.
			const ran = message.stopReason === "toolUse";
			for (const content of message.content) {
				if (content.type !== "toolCall") continue;
				const streamed = this.#streamingCalls.has(content.id);
				// Only cards the stream already showed are kept for calls that never run.
				if (!ran && !streamed) continue;
				const card = this.#tool(content.name, content.id, content.arguments, !streamed);
				card.setArgsComplete();
				if (!ran) {
					const text = "Not run: the answer was interrupted.";
					card.updateResult({ content: [{ type: "text", text }], isError: true }, false);
				}
			}
			this.#streamingCalls.clear();
		} else if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
			const result = message as ToolResultMessage;
			this.#tool(result.toolName, result.toolCallId).updateResult(result);
		} else if (entry.kind === "pi.compaction") {
			const summary = new CompactionComponent(
				message?.role === "user" ? userText(message.content) : "",
				this.#expanded,
			);
			this.#summaries.push(summary);
			this.#chat.addChild(new Spacer(1));
			this.#chat.addChild(summary);
		} else if (entry.kind === "pi.reset") this.#addText("[new context]");
	}

	#syncStreaming(message: AssistantMessage): void {
		if (this.#streaming === undefined) {
			this.#streaming = new AssistantMessageComponent();
			this.#chat.addChild(this.#streaming);
		}
		this.#streaming.updateContent(message, true);
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			this.#tool(content.name, content.id, content.arguments, !this.#streamingCalls.has(content.id));
			this.#streamingCalls.add(content.id);
		}
	}

	#addText(text: string): void {
		this.#chat.addChild(new Spacer(1));
		this.#chat.addChild(new Text(theme.fg("muted", text), 1, 0));
	}

	/** The card of a call; `fresh` starts a new one for a call ID an earlier turn used. */
	#tool(name: string, callId: string, args?: unknown, fresh = false): ToolExecutionComponent {
		const existing = fresh ? undefined : this.#tools.get(callId);
		if (existing !== undefined) {
			if (args !== undefined) existing.updateArgs(args);
			return existing;
		}
		const component = new ToolExecutionComponent(
			name,
			callId,
			args ?? {},
			{},
			DurableTui.#renderers[name],
			this.#ui,
			this.#cwd,
		);
		component.setExpanded(this.#expanded);
		this.#chat.addChild(component);
		this.#cards.push(component);
		this.#tools.set(callId, component);
		return component;
	}
}

function describeTask(node: TaskGraphNode): string {
	const state = node.state;
	const status =
		node.kind === "personal.routine" && state.status === "running" && state.phase === "wait"
			? "waiting for next scheduled run"
			: state.status === "waiting"
				? `waiting on ${state.on.join(", ")}`
				: state.status === "completing"
					? `completing (${state.outcome})`
					: `${state.status} ${state.phase}`;
	const flags = [node.background ? "background" : "", node.abortRequested ? "aborting" : ""].filter(Boolean);
	const owned = node.conversations.length > 0 ? ` owns conversation ${node.conversations.join(", ")}` : "";
	return `${node.kind} #${node.id}: ${status}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}${owned}`;
}

function userText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function totalUsage(state: UsageState): Usage {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const usage of [...Object.values(state.models), ...Object.values(state.tools)]) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost.total += usage.cost.total;
	}
	return total;
}

/** Context size from the newest successful answer after the newest compaction; unknown before one. */
function contextTokens(entries: readonly EntryRecord[]): number | undefined {
	// Kept entries follow the summary in the view but are older than it; only later answers measure the new context.
	const compacted = Math.max(0, ...entries.filter((entry) => entry.kind === "pi.compaction").map((entry) => entry.id));
	for (const entry of [...entries].reverse()) {
		const message = entry.model?.[0];
		if (entry.id < compacted || entry.kind !== "pi.assistant" || message?.role !== "assistant") continue;
		if (message.stopReason === "aborted" || message.stopReason === "error") continue;
		const usage = message.usage;
		return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	}
	return undefined;
}

export async function runDurableTui(
	source: DurableViewSource,
	controller: DurableController,
	settings: SettingsManager,
	terminal: Terminal = new ProcessTerminal(),
): Promise<void> {
	setCapabilityOverrides(settings.getTerminalCapabilityOverrides());
	// Register Sage's palette through Pi's native theme controller.
	registerSageTheme();
	settings.setTheme("sage");
	let exit = (): void => {};
	const exited = new Promise<void>((resolve) => {
		exit = resolve;
	});
	let view!: DurableTui;
	const inspect = async (kind: "skills" | "memory" | "schedules") => {
		const data = await controller.inspect(kind);
		if (data) view.showInspection(data);
	};

	const selectModel = async (): Promise<void> => {
		await controller.refreshModels();
		const snapshot = source.current();
		const current = agentOf(snapshot.conversation).model;
		const isCurrent = (model: { provider: string; modelId: string }) =>
			model.provider === current?.provider && model.modelId === current.modelId;
		const items: SelectItem[] = [...snapshot.models]
			.sort((left, right) => Number(isCurrent(right)) - Number(isCurrent(left)))
			.map((model) => ({
				value: `${model.provider}/${model.modelId}`,
				label: model.modelId,
				description: model.provider,
			}));
		const selector = new SagePicker("Models", items, "Type a model name to filter.", current && `${current.provider}/${current.modelId}`);
		selector.onSelect = (value) => {
			view.restoreEditor();
			const separator = value.indexOf("/");
			void controller.setModel({ provider: value.slice(0, separator), modelId: value.slice(separator + 1) });
		};
		selector.onCancel = () => view.restoreEditor();
		view.mount(selector);
	};

	const selectConversation = (): void => {
		const snapshot = source.current();
		const items: SelectItem[] = [{ value: "new", label: "+ New session", description: "Start a fresh chat" }, ...[...snapshot.conversations].reverse().map((candidate) => ({
			value: String(candidate.id),
			label: candidate.label,
			description: `${candidate.id === snapshot.conversation.conversation.id ? "(shown) " : ""}${candidate.title ?? ""}`,
		}))];
		const selector = new SagePicker("Sessions", items, "Create a session or return to a saved chat.", String(snapshot.conversation.conversation.id));
		selector.onSelect = (value) => {
			view.restoreEditor();
			if (value === "new") return void controller.newSession();
			void controller.switchConversation(Number(value) as ConversationId);
		};
		selector.onCancel = () => view.restoreEditor();
		view.mount(selector);
	};

	const submit = (text: string, mode: "steer" | "followUp") => {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (trimmed === "/model") return selectModel();
		if (trimmed === "/skills" || trimmed === "/memory") return void inspect(trimmed === "/skills" ? "skills" : "memory");
		if (trimmed === "/schedules" || trimmed === "/crons") return void inspect("schedules");
		if (trimmed === "/new") return void controller.newSession();
		if (trimmed === "/tasks") return void controller.toggleTasks();
		if (trimmed === "/sessions" || trimmed === "/agents") return selectConversation();
		if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
			const instructions = trimmed.slice("/compact".length).trim();
			return void controller.compact(instructions || undefined);
		}
		void controller.submit(trimmed, mode);
	};
	view = new DurableTui(source.current().session.cwd, {
		submit: (text) => submit(text, "steer"),
		followUp: (text) => submit(text, "followUp"),
		abort: () => void controller.abort(),
		exit,
		selectModel,
		cycleThinking: () => void controller.cycleThinking(),
	}, terminal);

	// pi's theme handling: the theme setting (also light/dark pairs) resolved against the terminal's reported colors.
	const themes = new InteractiveThemeController(view.ui, {
		getSettingsManager: () => settings,
		showError: (message) => console.error(message),
		onChanged: () => view.ui.requestRender(),
	});
	const unsubscribe = source.subscribe(() => view.apply(source.current()));
	view.start();
	themes.applyFromSettings();
	view.apply(source.current());
	await exited;
	unsubscribe();
	themes.dispose();
	view.stop();
}
