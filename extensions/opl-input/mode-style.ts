// Pure mode-to-style resolution for opl-input. No external imports so it can
// be unit-tested directly (tests/opl-input-style.test.mjs).

export interface ModeAppearance {
	prefix?: string;
	prefixColor?: string;
	borderColor?: string;
}

export interface ModeState {
	bash: boolean;
	mode: string;
	appearance?: ModeAppearance;
}

export interface ResolvedModeStyle {
	borderColor: string;
	prefixColor: string;
	prefix: string;
}

/** The baseline every unknown mode falls back to, kept as a constant so the fallback is a value
 *  rather than an index into a record that TypeScript must treat as possibly missing. */
const OFF_DEFAULT: Required<ModeAppearance> = { prefix: "❯", prefixColor: "accent", borderColor: "border" };

const MODE_DEFAULTS: Record<string, Required<ModeAppearance>> = {
	off: OFF_DEFAULT,
	chat: { prefix: "»", prefixColor: "borderAccent", borderColor: "borderAccent" },
	plan: { prefix: "⏸", prefixColor: "customMessageLabel", borderColor: "customMessageLabel" },
	execute: { prefix: "⏸", prefixColor: "customMessageLabel", borderColor: "customMessageLabel" },
};

/** Precedence: bash > active mode appearance > hardcoded mode fallback. */
export function resolveModeStyle(state: ModeState): ResolvedModeStyle {
	const fallback = MODE_DEFAULTS[state.mode] ?? OFF_DEFAULT;
	if (state.bash) return { borderColor: "bashMode", prefixColor: "bashMode", prefix: fallback.prefix };
	return {
		borderColor: state.appearance?.borderColor ?? fallback.borderColor,
		prefixColor: state.appearance?.prefixColor ?? fallback.prefixColor,
		prefix: state.appearance?.prefix ?? fallback.prefix,
	};
}
