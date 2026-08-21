/**
 * Todo Extension - State management via session entries + persistent overlay widget
 *
 * See README.md for full documentation.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeyId, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { CONFIG } from "./config.js";

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoDetails {
	action: "list" | "add" | "toggle" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

// ── Widget constants ─────────────────────────────────────────────────────────

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

/**
 * Persistent top-right overlay. Non-capturing — never steals editor focus.
 * Reads the shared `todos` array directly so render() always reflects live state.
 */
class TodoWidgetComponent {
	constructor(
		private readonly todos: Todo[],
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const th = this.theme;
		const t = this.todos;
		const maxItems = Math.max(3, Math.floor((process.stdout.rows || 24) * CONFIG.widget.maxHeightPercent / 100) - 5);
		const W = Math.max(width, CONFIG.widget.minWidth);

		const b = (s: string) => th.fg("border", s);
		const dim = (s: string) => th.fg("dim", s);

		const innerW = W - 4;
		const contentRow = (content: string): string => {
			const vis = visibleWidth(content);
			const padding = " ".repeat(Math.max(0, innerW - vis));
			return b("│") + " " + truncateToWidth(content, innerW) + padding + " " + b("│");
		};

		const lines: string[] = [];

		const titleVis = 9; // " ☑ Todos " = 9 visible chars
		const topFill = "─".repeat(Math.max(0, W - 2 - titleVis));
		lines.push(
			b("╭") +
			" " + th.fg("accent", "☑") + " " + th.fg("accent", "Todos") + " " +
			b(topFill + "╮"),
		);

		if (t.length === 0) {
			lines.push(contentRow(dim("No active todos")));
		} else {
			for (const todo of t.slice(0, maxItems)) {
				const check = todo.done ? th.fg("success", "✓") : dim("○");
				const id = th.fg("accent", `#${todo.id}`);
				const text = todo.done ? dim(todo.text) : todo.text;
				lines.push(contentRow(`${check} ${id} ${text}`));
			}
			if (t.length > maxItems) {
				lines.push(contentRow(dim(`… +${t.length - maxItems} more`)));
			}
			const done = t.filter((x) => x.done).length;
			const prog = done === t.length
				? th.fg("success", "✓ All done!")
				: dim(`${done}/${t.length} completed`);
			lines.push(contentRow(prog));
		}

		const resetStr = ` ${CONFIG.shortcuts.resetDone} `;
		const toggleStr = ` ${CONFIG.shortcuts.toggleWidget} `;
		const botFill = "─".repeat(Math.max(0, W - 2 - resetStr.length - toggleStr.length));
		lines.push(b("╰") + dim(resetStr) + b(botFill) + dim(toggleStr) + b("╯"));

		return lines;
	}

	invalidate(): void {}
}

/**
 * Modal list component for the /todos command.
 */
class TodoListComponent {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly todos: Todo[],
		private readonly theme: Theme,
		private readonly onClose: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`, width));
		} else {
			const done = this.todos.filter((t) => t.done).length;
			const total = this.todos.length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${total} completed`)}`, width));
			lines.push("");
			for (const todo of this.todos) {
				const check = todo.done ? th.fg("success", "✓") : th.fg("dim", "○");
				const id = th.fg("accent", `#${todo.id}`);
				const text = todo.done ? th.fg("dim", todo.text) : th.fg("text", todo.text);
				lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	// ── Shared state ─────────────────────────────────────────────────────────────
	const todos: Todo[] = [];
	let nextId = 1;

	// ── Widget handles ─────────────────────────────────────────────────────
	let overlayHandle: OverlayHandle | undefined;
	let tuiRef: TUI | undefined;
	let autoHideTimer: ReturnType<typeof setTimeout> | undefined;

	function showWidget(): void {
		clearTimeout(autoHideTimer);
		overlayHandle?.setHidden(false);
		tuiRef?.requestRender();
	}
	function hideWidget(): void {
		clearTimeout(autoHideTimer);
		overlayHandle?.setHidden(true);
		tuiRef?.requestRender();
	}
	function scheduleAutoHide(): void {
		clearTimeout(autoHideTimer);
		autoHideTimer = setTimeout(() => {
			overlayHandle?.setHidden(true);
			tuiRef?.requestRender();
		}, CONFIG.allDoneHideMs);
	}

	// ── State reconstruction ──────────────────────────────────────────────
	const reconstructState = (ctx: ExtensionContext) => {
		todos.length = 0;
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
			const details = msg.details as TodoDetails | undefined;
			if (details) {
				todos.length = 0;
				todos.push(...details.todos);
				nextId = details.nextId;
			}
		}

		// Auto-clear on load/resume if everything was already finished
		if (todos.length > 0 && todos.every((t) => t.done)) {
			todos.length = 0;
			nextId = 1;
		}

		if (overlayHandle) {
			overlayHandle.setHidden(todos.length === 0);
			tuiRef?.requestRender();
		}
	};

	// ── Session events ──────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		if (ctx.mode !== "tui") return;

		void ctx.ui.custom<void>(
			(tui, theme, _kb, _done) => {
				tuiRef = tui;
				return new TodoWidgetComponent(todos, theme);
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "top-right",
					offsetX: -1,
					offsetY: 0,
					width: `${CONFIG.widget.widthPercent}%`,
					nonCapturing: true,
					visible: (w) => w >= 80,
				},
				onHandle: (h) => {
					overlayHandle = h;
					h.setHidden(todos.length === 0);
				},
			},
		);
	});

	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// ── Shortcuts ────────────────────────────────────────────────────────────
	pi.registerShortcut(CONFIG.shortcuts.toggleWidget as KeyId, {
		description: "Toggle todo widget",
		handler: (_ctx) => {
			if (!overlayHandle) return;
			if (overlayHandle.isHidden()) showWidget();
			else hideWidget();
		},
	});

	pi.registerShortcut(CONFIG.shortcuts.resetDone as KeyId, {
		description: "Clear completed todos (only when all are done)",
		handler: (_ctx) => {
			if (todos.length === 0 || !todos.every((t) => t.done)) return;
			todos.length = 0;
			nextId = 1;
			hideWidget();
		},
	});

	// ── Tool ───────────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage a todo list. Actions: list, add (text), toggle (id), clear",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.action) {
				case "list":
					return {
						content: [{
							type: "text",
							text: todos.length
								? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
								: "No todos",
						}],
						details: { action: "list", todos: [...todos], nextId } as TodoDetails,
					};

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { action: "add", todos: [...todos], nextId, error: "text required" } as TodoDetails,
						};
					}
					// Fresh batch: if all existing tasks are done, clear them first
					if (todos.length > 0 && todos.every((t) => t.done)) {
						todos.length = 0;
						nextId = 1;
						clearTimeout(autoHideTimer);
					}
					const cleanText = params.text.replace(/^step\s*\d+[:.\s-]+/i, "").trim();
				const newTodo: Todo = { id: nextId++, text: cleanText, done: false };
					todos.push(newTodo);
					showWidget();
					return {
						content: [{ type: "text", text: `Added todo #${newTodo.id}: ${newTodo.text}` }],
						details: { action: "add", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for toggle" }],
							details: { action: "toggle", todos: [...todos], nextId, error: "id required" } as TodoDetails,
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: { action: "toggle", todos: [...todos], nextId, error: `#${params.id} not found` } as TodoDetails,
						};
					}
					todo.done = !todo.done;
					showWidget();
					if (todos.every((t) => t.done)) scheduleAutoHide();
					return {
						content: [{ type: "text", text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}` }],
						details: { action: "toggle", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "clear": {
					const count = todos.length;
					todos.length = 0;
					nextId = 1;
					hideWidget();
					return {
						content: [{ type: "text", text: `Cleared ${count} todos` }],
						details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: { action: "list", todos: [...todos], nextId, error: `unknown: ${params.action}` } as TodoDetails,
					};
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);

			const todoList = details.todos;
			switch (details.action) {
				case "list": {
					if (todoList.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);
					let listText = theme.fg("muted", `${todoList.length} todo(s):`);
					const display = expanded ? todoList : todoList.slice(0, 5);
					for (const t of display) {
						const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
						const itemText = t.done ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
						listText += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					if (!expanded && todoList.length > 5) listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
					return new Text(listText, 0, 0);
				}
				case "add": {
					const added = todoList[todoList.length - 1];
					return new Text(
						theme.fg("success", "✓ Added ") + theme.fg("accent", `#${added.id}`) + " " + theme.fg("muted", added.text),
						0, 0,
					);
				}
				case "toggle": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}
				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);
			}
		},
	});

	// ── Command: /todos ──────────────────────────────────────────────────────────────
	pi.registerCommand("todos", {
		description: "Show all todos on the current branch",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}
