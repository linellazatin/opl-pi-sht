import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CONFIG = {
	BOX_PAD_X: 1,
	MENU_GAP: 0,
	EXTRA_MENU_INDENT: 1,
	BOXED_VIEW: true,
	COMPANION_ENABLED: false,
	COMPANION_COLOR: "accent" as const,
	COMPANION_TOP_PADDING: 3,
};

interface ChatInputUserConfig {
	boxedView?: boolean;
	boxPadX?: number;
	menuGap?: number;
	extraMenuIndent?: number;
	companion?: {
		enabled?: boolean;
		color?: string;
		type?: string;
		ears?: string;
		types?: Array<{
			typeName: string;
			top: string;
		}>;
	};
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "configs", "opl-input.json");

function loadUserConfig(): ChatInputUserConfig {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf8");
		return JSON.parse(raw) as ChatInputUserConfig;
	} catch {
		return {};
	}
}

const userConfig = loadUserConfig();

export const CONFIG = {
	BOX_PAD_X: userConfig.boxPadX ?? DEFAULT_CONFIG.BOX_PAD_X,
	MENU_GAP: userConfig.menuGap ?? DEFAULT_CONFIG.MENU_GAP,
	EXTRA_MENU_INDENT: userConfig.extraMenuIndent ?? DEFAULT_CONFIG.EXTRA_MENU_INDENT,
	BOXED_VIEW: userConfig.boxedView ?? DEFAULT_CONFIG.BOXED_VIEW,
	COMPANION_ENABLED: userConfig.companion?.enabled ?? DEFAULT_CONFIG.COMPANION_ENABLED,
	COMPANION_COLOR: (userConfig.companion?.color ?? DEFAULT_CONFIG.COMPANION_COLOR) as string,
	COMPANION_TOP_PADDING: DEFAULT_CONFIG.COMPANION_TOP_PADDING,
	COMPANION_EARS: resolveEars(userConfig.companion),
};

function resolveEars(companion?: ChatInputUserConfig["companion"]): string {
	if (companion?.ears) return companion.ears;
	if (companion?.type && companion?.types) {
		const found = companion.types.find((t) => t.typeName === companion.type);
		if (found) return found.top;
	}
	if (companion?.type === "dog") return " /)_(\\ ";
	return " /\\_/\\ ";
}

// Non-user-configurable constants
export const COMPANION_PADDING = 3;
export const MIN_WIDTH_FOR_COMPANION = 40;

// ── animation timing (all in ms) ────────────────────────────────────
export const DIP_INTERVAL_MS = 4000;
export const RISE_INTERVAL_MS = 8000;
export const EARS_MIN_DURATION_MS = 2000;
export const EARS_MAX_DURATION_MS = 4000;
export const FULL_MIN_DURATION_MS = 3000;
export const FULL_MAX_DURATION_MS = 23000;
export const NONE_MIN_DURATION_MS = 800;
export const NONE_MAX_DURATION_MS = 2000;
export const FACE_MIN_DURATION_MS = 6000;
export const FACE_MAX_DURATION_MS = 36000;

// expression cycling
export const EXPR_MIN_DURATION_MS = 2000;
export const EXPR_MAX_DURATION_MS = 5500;
export const STARE_MIN_DURATION_MS = 8000;
export const STARE_MAX_DURATION_MS = 13000;
export const STARE_CHANCE = 0.15;
export const BLINK_MIN_DURATION_MS = 80;
export const BLINK_MAX_DURATION_MS = 330;

// expression transition: blink vs instant vs double-blink
export const EXPR_BLINK_CHANCE = 0.50;
export const EXPR_DOUBLE_BLINK_CHANCE = 0;     // disabled
export const DOUBLE_BLINK_GAP_MIN_MS = 80;
export const DOUBLE_BLINK_GAP_MAX_MS = 160;

// wobble (ears phase)
export const WOBBLE_RANGE = 12;
export const WOBBLE_MIN_INTERVAL_MS = 200;
export const WOBBLE_MAX_INTERVAL_MS = 600;
export const DIR_STEPS_MIN = 2;
export const DIR_STEPS_MAX = 5;
export const EDGE_BIAS_STRENGTH = 0.45;
export const EDGE_PAUSE_MIN_MS = 300;
export const EDGE_PAUSE_MAX_MS = 800;

// face micro-drift
export const FACE_DRIFT_RANGE = 3;
export const FACE_DRIFT_MIN_INTERVAL_MS = 4000;
export const FACE_DRIFT_MAX_INTERVAL_MS = 10000;

// phase transitions
export const EARS_TO_NONE_CHANCE = 0.15;
export const EARS_TO_FULL_CHANCE = 0.425;       // remainder = face
export const FULL_TO_EARS_CHANCE = 0.15;
export const FULL_TO_NONE_CHANCE = 0.10;         // remainder = face

// transition frames
export const SLOW_TRANSITION_CHANCE = 0.2;
export const SLOW_TRANSITION_MULT_MIN = 2;
export const SLOW_TRANSITION_MULT_MAX = 3;

export const BLINK_ART: [string, string, string] = [" /\\_/\\ ", "( -.- )", " |   | "];

const EARS = CONFIG.COMPANION_EARS;
export const COMPANION_ARTS: [string, string, string][] = [
	[EARS, "( ⌒.⌒ )", " |   | "],  // happy
	[EARS, "( o.o )", " |   | "],  // original
	[EARS, "( ^.^ )", " |   | "],  // happy
	[EARS, "( O.O )", " |   | "],  // awake
	[EARS, "( o.- )", " |   | "],  // winking
	[EARS, "( >.< )", " |   | "],  // closed
	[EARS, "( o.O )", " |   | "],  // curious
	[EARS, "( *.* )", " |   | "],  // sparkle
	[EARS, "( ᴗ.ᴗ )", " |   | "],  // unimpressed
	[EARS, "( ω.ω )", " |   | "],  // joyful
];