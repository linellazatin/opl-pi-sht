// Pure mode-to-style resolution for opl-input. No external imports so it can
// be unit-tested directly (tests/opl-input-style.test.mjs).

export interface ModeState {
	bash: boolean;
	plan: boolean;
	chat: boolean;
	/** Active custom mode name, or null. */
	custom: string | null;
}

export interface ModeStyleConfig {
	PREFIX: string;
	BORDER_COLOR: string;
	PREFIX_COLOR: string;
	PLAN_MODE_PREFIX: string;
	PLAN_MODE_BORDER_COLOR: string;
	PLAN_MODE_PREFIX_COLOR: string;
	CHAT_MODE_PREFIX: string;
	CHAT_MODE_BORDER_COLOR: string;
	CHAT_MODE_PREFIX_COLOR: string;
	MODES: Record<string, { prefix?: string; prefixColor?: string; borderColor?: string } | undefined>;
}

export interface ResolvedModeStyle {
	borderColor: string;
	prefixColor: string;
	prefix: string;
}

/** Precedence: bash > plan/execute > chat > custom mode > default. */
export function resolveModeStyle(state: ModeState, cfg: ModeStyleConfig): ResolvedModeStyle {
	if (state.bash) {
		return { borderColor: "bashMode", prefixColor: "bashMode", prefix: cfg.PREFIX };
	}
	if (state.plan) {
		return {
			borderColor: cfg.PLAN_MODE_BORDER_COLOR,
			prefixColor: cfg.PLAN_MODE_PREFIX_COLOR,
			prefix: cfg.PLAN_MODE_PREFIX,
		};
	}
	if (state.chat) {
		return {
			borderColor: cfg.CHAT_MODE_BORDER_COLOR,
			prefixColor: cfg.CHAT_MODE_PREFIX_COLOR,
			prefix: cfg.CHAT_MODE_PREFIX,
		};
	}
	const customCfg = state.custom ? cfg.MODES[state.custom] : undefined;
	if (state.custom && customCfg) {
		return {
			borderColor: customCfg.borderColor ?? cfg.BORDER_COLOR,
			prefixColor: customCfg.prefixColor ?? cfg.PREFIX_COLOR,
			prefix: customCfg.prefix ?? cfg.PREFIX,
		};
	}
	return { borderColor: cfg.BORDER_COLOR, prefixColor: cfg.PREFIX_COLOR, prefix: cfg.PREFIX };
}
