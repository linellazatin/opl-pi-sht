import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TodoConfig {
	allDoneHideMs: number;
	shortcuts: {
		toggleWidget: string;
		resetDone: string;
	};
	widget: {
		widthPercent: number;
		maxHeightPercent: number;
		minWidth: number;
	};
}

const DEFAULT: TodoConfig = {
	allDoneHideMs: 5000,
	shortcuts: {
		toggleWidget: "ctrl+alt+t",
		resetDone: "ctrl+alt+r",
	},
	widget: {
		widthPercent: 33,
		maxHeightPercent: 50,
		minWidth: 32,
	},
};

function load(): TodoConfig {
	const path = join(homedir(), ".pi", "agent", "configs", "opl-todo.json");
	try {
		if (!existsSync(path)) return DEFAULT;
		const raw = JSON.parse(readFileSync(path, "utf8"));
		return {
			allDoneHideMs:
				typeof raw.allDoneHideMs === "number" && raw.allDoneHideMs >= 0
					? raw.allDoneHideMs
					: DEFAULT.allDoneHideMs,
			shortcuts: {
				toggleWidget:
					typeof raw.shortcuts?.toggleWidget === "string"
						? raw.shortcuts.toggleWidget
						: DEFAULT.shortcuts.toggleWidget,
				resetDone:
					typeof raw.shortcuts?.resetDone === "string"
						? raw.shortcuts.resetDone
						: DEFAULT.shortcuts.resetDone,
			},
			widget: {
				widthPercent:
					typeof raw.widget?.widthPercent === "number" && raw.widget.widthPercent > 0 && raw.widget.widthPercent <= 100
						? raw.widget.widthPercent
						: DEFAULT.widget.widthPercent,
				maxHeightPercent:
					typeof raw.widget?.maxHeightPercent === "number" && raw.widget.maxHeightPercent > 0 && raw.widget.maxHeightPercent <= 100
						? raw.widget.maxHeightPercent
						: DEFAULT.widget.maxHeightPercent,
				minWidth:
					typeof raw.widget?.minWidth === "number" && raw.widget.minWidth >= 20
						? raw.widget.minWidth
						: DEFAULT.widget.minWidth,
			},
		};
	} catch {
		return DEFAULT;
	}
}

export const CONFIG = load();
