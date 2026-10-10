import { CustomEditor, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, EditorTheme } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { CONFIG, COMPANION_PADDING, MIN_WIDTH_FOR_COMPANION } from "./config.js";
import { registerInputConfiguratorTab } from "./configure.js";
import { resolveModeStyle, type ModeAppearance } from "./mode-style.js";
import { applyColor, CompanionAnimator, COMPANION_TICK_MS, IDLE_REPAINT_MS, startRenderTimer } from "./utils.js";

// ─── Helpers ──────────────────────────────────────────────────────────────
const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\[0?m/g;

function plainText(line: string): string {
	return line.replace(ANSI_RE, "");
}

// ─── pi-tui private render format ─────────────────────────────────────────────
// The box renderers below must tell the editor's horizontal borders from its scroll
// indicator, and pi-tui exposes neither as an API nor as a stable class: it is plain text.
// These two markers are the whole contract, so they live here instead of being duplicated in
// each renderer, and tests/opl-input-pi-tui-markers.test.mjs asserts the installed pi-tui
// still emits them. Verified byte-identical in pi-tui 0.87.0, 0.99.1 and 1.1.0
// (dist/components/editor.js: `─── ${direction} ${hiddenLineCount} more `).
const BORDER_CHAR = "─";
const SCROLL_INDICATOR_RE = /((?:↑|↓)\s*\d+\s*more)/;

/** Solid border: after stripping ANSI every character is the box-drawing horizontal. */
export function isSolidBorder(line: string): boolean {
	return plainText(line).replaceAll(BORDER_CHAR, "").length === 0;
}

/** The scroll indicator (`─── ↑ 3 more `) is border-like but carries text worth preserving. */
export function scrollIndicatorText(line: string): string | null {
	const plain = plainText(line);
	if (!plain.startsWith(BORDER_CHAR)) return null;
	const match = plain.match(SCROLL_INDICATOR_RE);
	return match ? match[1]! : null;
}

/** Anything that marks the top or bottom edge of the stock editor output. */
export function isBorderLike(line: string): boolean {
	return isSolidBorder(line) || scrollIndicatorText(line) !== null;
}

function activeMode(): { mode: string; appearance?: ModeAppearance } {
	const state = (globalThis as Record<string, unknown>).__agentMode as
		| { mode?: string; appearance?: ModeAppearance }
		| undefined;
	return { mode: state?.mode ?? "off", appearance: state?.appearance };
}

// ─── Component ────────────────────────────────────────────────────────────
class ChatInput extends CustomEditor {
	private companionColor: (s: string) => string;
	// Full Theme (not EditorTheme): custom-mode colors resolve through theme.fg,
	// which EditorTheme does not implement.
	private uiTheme: Theme;
	private inputTheme: EditorTheme;
	private animator = new CompanionAnimator();
	private stopCompanionTimer: (() => void) | null = null;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		companionColor: (s: string) => string,
		uiTheme: Theme,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.companionColor = companionColor;
		this.uiTheme = uiTheme;
		this.inputTheme = theme;

		// Animate companion even when idle — tick drives state machine
		// With the companion hidden this component still owns the only idle repaint in the
		// bundle (footer time-based cells read it), so the tick slows down instead of stopping.
		this.stopCompanionTimer = startRenderTimer(
			() => {
				this.animator.tick(Date.now());
				this.tui.requestRender();
			},
			CONFIG.COMPANION_ENABLED ? COMPANION_TICK_MS : IDLE_REPAINT_MS,
		);
	}

	dispose(): void {
		this.stopCompanionTimer?.();
		this.stopCompanionTimer = null;
	}

	private isBashMode(): boolean {
		const text = (this as any).getText?.();
		return typeof text === "string" && text.trimStart().startsWith("!");
	}

	render(width: number): string[] {
		const padMultiplier = CONFIG.BOXED_VIEW ? 3 : 1;
		if (width < 5 + CONFIG.BOX_PAD_X * padMultiplier) return super.render(width);

		const contentWidth = CONFIG.BOXED_VIEW
			? width - 3 - CONFIG.BOX_PAD_X * 3
			: width - 2 * CONFIG.BOX_PAD_X - 1;
		const stock = super.render(contentWidth);
		if (stock.length < 2) return super.render(width);

		const isBash = this.isBashMode();
		const mode = activeMode();
		const style = resolveModeStyle({ bash: isBash, mode: mode.mode, appearance: mode.appearance });
		const border = (s: string) => applyColor(this.uiTheme, style.borderColor, s);
		const accent = (s: string) => applyColor(this.uiTheme, style.prefixColor, s);
		// The layout reserves exactly one cell for the prefix (continuation lines pad with " "),
		// so a wider configured prefix would push the box border past `width`.
		const prefix = truncateToWidth(style.prefix, 1);

		if (CONFIG.BOXED_VIEW) {
			return this.renderBoxed(stock, contentWidth, width, border, accent, prefix);
		}
		return this.renderUnboxed(stock, contentWidth, width, border, accent, prefix);
	}

	private buildCompanionLines(width: number): string[] {
		if (!CONFIG.COMPANION_ENABLED || width < MIN_WIDTH_FOR_COMPANION) return [];

		const state = this.animator.getState();
		const artWidth = Math.max(...state.lines.map(l => visibleWidth(l)), 0);
		const rawPad = width - COMPANION_PADDING - artWidth + state.extraPad;
		// Clamp: never negative, never exceed terminal width
		const pad = Math.max(0, Math.min(rawPad, width - artWidth));
		const spaces = " ".repeat(pad);

		const lines: string[] = [];
		for (const line of state.lines) {
			lines.push(spaces + this.companionColor(line));
		}
		const topPadding = CONFIG.COMPANION_ENABLED ? CONFIG.COMPANION_TOP_PADDING : 0;
		// Reserve topPadding lines so chat bar doesn't jump — art anchored to bottom
		while (lines.length < topPadding) {
			lines.unshift("");
		}
		return lines;
	}

	private renderBoxed(
		stock: string[],
		contentWidth: number,
		width: number,
		border: (s: string) => string,
		accent: (s: string) => string,
		prefix: string,
	): string[] {
		const innerWidth = width - 2;

		const firstIdx = stock.findIndex(isBorderLike);
		let lastIdx = -1;
		for (let i = stock.length - 1; i >= 0; i--) {
			if (isBorderLike(stock[i]!)) {
				lastIdx = i;
				break;
			}
		}

		// Build top/bottom box borders, embedding scroll indicator text when present
		const buildTop = (scrollText: string | null): string => {
			if (!scrollText) return border("┌") + border("─".repeat(innerWidth)) + border("┐");
			const mid = `── ${scrollText} `;
			const remaining = Math.max(0, innerWidth - visibleWidth(mid));
			return border("┌") + border(mid) + border("─".repeat(remaining)) + border("┐");
		};

		const buildBottom = (scrollText: string | null): string => {
			if (!scrollText) return border("└") + border("─".repeat(innerWidth)) + border("┘");
			const mid = `── ${scrollText} `;
			const remaining = Math.max(0, innerWidth - visibleWidth(mid));
			return border("└") + border(mid) + border("─".repeat(remaining)) + border("┘");
		};

		const topScrollText = firstIdx !== -1 ? scrollIndicatorText(stock[firstIdx]!) : null;
		const bottomScrollText = lastIdx !== -1 && lastIdx !== firstIdx ? scrollIndicatorText(stock[lastIdx]!) : null;

		const top = buildTop(topScrollText);
		const bottom = buildBottom(bottomScrollText);

		// ── companion art ──
		const companionLines = this.buildCompanionLines(width);

		const leftPad = " ".repeat(CONFIG.BOX_PAD_X);
		const rightPad = leftPad;

		// ── body lines (between first and last border/indicator) ──
		const body: string[] = [];
		let isFirstBodyLine = true;
		for (let i = 0; i < stock.length; i++) {
			if (i === firstIdx || i === lastIdx) continue;
			if (lastIdx !== -1 && i > lastIdx) continue;

			const vw = visibleWidth(stock[i]!);
			const pad = vw < contentWidth ? " ".repeat(contentWidth - vw) : "";
			const prefixStr = isFirstBodyLine ? accent(prefix) : " ";
			body.push(border("│") + leftPad + prefixStr + leftPad + stock[i]! + pad + rightPad + border("│"));
			isFirstBodyLine = false;
		}

		// ── menu lines (after last border/indicator) ──
		const menu: string[] = [];
		if (lastIdx !== -1) {
			for (let i = lastIdx + 1; i < stock.length; i++) {
				const vw = visibleWidth(stock[i]!);
				const indent = " ".repeat(CONFIG.EXTRA_MENU_INDENT);
				const pad = vw + CONFIG.EXTRA_MENU_INDENT < width ? " ".repeat(width - vw - CONFIG.EXTRA_MENU_INDENT) : "";
				menu.push(indent + stock[i]! + pad);
			}
		}

		const gap = Array.from({ length: CONFIG.MENU_GAP }, () => "");
		return [...companionLines, top, ...body, bottom, ...gap, ...menu];
	}

	private renderUnboxed(
		stock: string[],
		contentWidth: number,
		width: number,
		border: (s: string) => string,
		accent: (s: string) => string,
		prefix: string,
	): string[] {
		const firstIdx = stock.findIndex(isBorderLike);
		let lastIdx = -1;
		for (let i = stock.length - 1; i >= 0; i--) {
			if (isBorderLike(stock[i]!)) {
				lastIdx = i;
				break;
			}
		}

		// Build top/bottom horizontal borders only (no corners, no sides)
		const buildTop = (scrollText: string | null): string => {
			if (!scrollText) return border("─".repeat(width));
			const mid = `── ${scrollText} `;
			const remaining = Math.max(0, width - visibleWidth(mid));
			return border(mid) + border("─".repeat(remaining));
		};

		const buildBottom = (scrollText: string | null): string => {
			if (!scrollText) return border("─".repeat(width));
			const mid = `── ${scrollText} `;
			const remaining = Math.max(0, width - visibleWidth(mid));
			return border(mid) + border("─".repeat(remaining));
		};

		const topScrollText = firstIdx !== -1 ? scrollIndicatorText(stock[firstIdx]!) : null;
		const bottomScrollText = lastIdx !== -1 && lastIdx !== firstIdx ? scrollIndicatorText(stock[lastIdx]!) : null;

		const top = buildTop(topScrollText);
		const bottom = buildBottom(bottomScrollText);

		// ── companion art ──
		const companionLines = this.buildCompanionLines(width);

		const leftPad = " ".repeat(CONFIG.BOX_PAD_X);

		// ── body lines ──
		const body: string[] = [];
		let isFirstBodyLine = true;
		for (let i = 0; i < stock.length; i++) {
			if (i === firstIdx || i === lastIdx) continue;
			if (lastIdx !== -1 && i > lastIdx) continue;

			const vw = visibleWidth(stock[i]!);
			const pad = vw < contentWidth ? " ".repeat(contentWidth - vw) : "";
			const prefixStr = isFirstBodyLine ? accent(prefix) : " ";
			body.push(leftPad + prefixStr + leftPad + stock[i]! + pad);
			isFirstBodyLine = false;
		}

		// ── menu lines ──
		const menu: string[] = [];
		if (lastIdx !== -1) {
			for (let i = lastIdx + 1; i < stock.length; i++) {
				const vw = visibleWidth(stock[i]!);
				const indent = " ".repeat(CONFIG.EXTRA_MENU_INDENT);
				const pad = vw + CONFIG.EXTRA_MENU_INDENT < width ? " ".repeat(width - vw - CONFIG.EXTRA_MENU_INDENT) : "";
				menu.push(indent + stock[i]! + pad);
			}
		}

		const gap = Array.from({ length: CONFIG.MENU_GAP }, () => "");
		return [...companionLines, top, ...body, bottom, ...gap, ...menu];
	}
}

// ─── Extension entry ──────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	let activeEditor: ChatInput | null = null;

	pi.on("session_start", async (_event, ctx) => {
		activeEditor?.dispose();
		activeEditor = null;
		ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, kb: KeybindingsManager) => {
			activeEditor?.dispose();
			const companionColorFn = (s: string) => applyColor(ctx.ui.theme, CONFIG.COMPANION_COLOR, s);
			activeEditor = new ChatInput(tui, theme, kb, companionColorFn, ctx.ui.theme);
			return activeEditor;
		});
	});

	pi.on("session_shutdown", async () => {
		activeEditor?.dispose();
		activeEditor = null;
	});

	// Expose the settings screen to opl-configurator's generic shell; the shell owns the
	// /configurator command and the tab only writes opl-input.json (a /reload is still
	// required before the running editor picks the change up).
	registerInputConfiguratorTab();
}
