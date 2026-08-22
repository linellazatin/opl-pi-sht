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

const MODE_DEFAULTS: Record<string, Required<ModeAppearance>> = {
	off: { prefix: "❯", prefixColor: "accent", borderColor: "border" },
	chat: { prefix: "»", prefixColor: "chatModeBorder", borderColor: "chatModeBorder" },
	plan: { prefix: "⏸", prefixColor: "customMessageLabel", borderColor: "customMessageLabel" },
	execute: { prefix: "⏸", prefixColor: "customMessageLabel", borderColor: "customMessageLabel" },
};

/** Precedence: bash > active mode appearance > hardcoded mode fallback. */
export function resolveModeStyle(state: ModeState): ResolvedModeStyle {
	const fallback = MODE_DEFAULTS[state.mode] ?? MODE_DEFAULTS.off;
	if (state.bash) return { borderColor: "bashMode", prefixColor: "bashMode", prefix: fallback.prefix };
	return {
		borderColor: state.appearance?.borderColor ?? fallback.borderColor,
		prefixColor: state.appearance?.prefixColor ?? fallback.prefixColor,
		prefix: state.appearance?.prefix ?? fallback.prefix,
	};
}
