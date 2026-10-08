import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type Op = "read" | "write" | "edit" | "bash";

export interface PathEntry {
  path: string;
  deny: Op[];
}

export interface GuardianConfig {
  permissionGate: {
    patterns: RegExp[];
    blockWithoutUI: boolean;
  };
  protectedPaths: {
    paths: PathEntry[];
  };
  confirmDestructive: {
    clearSession: boolean;
    switchWithUnsavedWork: boolean;
    forkSession: boolean;
    blockWithoutUI: boolean;
  };
  dropMalformedToolCalls: boolean;
}

const DEFAULT_PATTERN_STRINGS = [
  "\\brm\\s+(?:(?:-[a-z]+|--[a-z-]+)\\s+)*(?:-[a-z]*r[a-z]*|--recursive)(?=\\s|$)",
  "\\bsudo\\b",
  "\\b(chmod|chown)\\s+(?:-[a-z]+\\s+)*777(?:\\b|$)",
  "\\bprintenv\\b",
  "(?:^|[;&|()\\n])\\s*env(?:[\\s)|]|$)",
];

const DEFAULT_PATHS: PathEntry[] = [
  { path: ".env", deny: ["read", "write", "edit", "bash"] },
  { path: ".git/", deny: ["read", "write", "edit"] },
  { path: "node_modules/", deny: ["write", "edit"] },
  { path: "~/.pi/agent/auth.json", deny: ["read", "write", "edit", "bash"] },
];

export const DEFAULT_CONFIG: GuardianConfig = {
  permissionGate: {
    patterns: DEFAULT_PATTERN_STRINGS.map((pattern) => new RegExp(pattern, "i")),
    blockWithoutUI: true,
  },
  protectedPaths: { paths: DEFAULT_PATHS },
  confirmDestructive: {
    clearSession: true,
    switchWithUnsavedWork: true,
    forkSession: true,
    blockWithoutUI: true,
  },
  dropMalformedToolCalls: true,
};

/** Resolved per call so a custom `PI_AGENT_DIR` (pi's own agent dir) is honoured. */
export function configPath(): string {
  return join(getAgentDir(), "configs", "opl-guardian.json");
}
const OPS = new Set<Op>(["read", "write", "edit", "bash"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDefaults(): GuardianConfig {
  return {
    permissionGate: {
      patterns: DEFAULT_PATTERN_STRINGS.map((pattern) => new RegExp(pattern, "i")),
      blockWithoutUI: true,
    },
    protectedPaths: { paths: DEFAULT_PATHS.map((entry) => ({ ...entry, deny: [...entry.deny] })) },
    confirmDestructive: { ...DEFAULT_CONFIG.confirmDestructive },
    dropMalformedToolCalls: true,
  };
}

export function parseGuardianConfig(value: unknown): { config: GuardianConfig; warnings: string[] } {
  const config = cloneDefaults();
  const warnings: string[] = [];

  if (value === undefined) return { config, warnings };
  if (!isRecord(value)) {
    return { config, warnings: ["Invalid opl-guardian config: expected a JSON object; using defaults."] };
  }

  if (value.permissionGate !== undefined) {
    if (!isRecord(value.permissionGate)) {
      warnings.push("Invalid permissionGate section; using defaults.");
    } else {
      const section = value.permissionGate;
      if (section.patterns !== undefined) {
        if (!Array.isArray(section.patterns)) {
          warnings.push("permissionGate.patterns must be an array; using defaults.");
        } else if (section.patterns.length === 0) {
          config.permissionGate.patterns = [];
        } else {
          const patterns: RegExp[] = [];
          for (const pattern of section.patterns) {
            if (typeof pattern !== "string") {
              warnings.push("permissionGate.patterns entries must be strings; ignoring invalid entry.");
              continue;
            }
            try {
              patterns.push(new RegExp(pattern, "i"));
            } catch {
              warnings.push("Invalid permissionGate regex; ignoring it.");
            }
          }
          config.permissionGate.patterns = patterns.length > 0
            ? patterns
            : DEFAULT_PATTERN_STRINGS.map((pattern) => new RegExp(pattern, "i"));
        }
      }
      if (section.blockWithoutUI !== undefined) {
        if (typeof section.blockWithoutUI === "boolean") {
          config.permissionGate.blockWithoutUI = section.blockWithoutUI;
        } else {
          warnings.push("permissionGate.blockWithoutUI must be a boolean; using true.");
        }
      }
    }
  }

  if (value.protectedPaths !== undefined) {
    if (!isRecord(value.protectedPaths)) {
      warnings.push("Invalid protectedPaths section; using defaults.");
    } else if (value.protectedPaths.paths !== undefined) {
      const inputPaths = value.protectedPaths.paths;
      if (!Array.isArray(inputPaths)) {
        warnings.push("protectedPaths.paths must be an array; using defaults.");
      } else if (inputPaths.length === 0) {
        config.protectedPaths.paths = [];
      } else {
        const paths: PathEntry[] = [];
        for (const item of inputPaths) {
          if (!isRecord(item) || typeof item.path !== "string" || item.path.trim().length === 0 ||
            !Array.isArray(item.deny) || !item.deny.every((op): op is Op => typeof op === "string" && OPS.has(op as Op))) {
            warnings.push("Invalid protectedPaths entry; ignoring it.");
            continue;
          }
          paths.push({ path: item.path, deny: item.deny as Op[] });
        }
        config.protectedPaths.paths = paths.length > 0
          ? paths
          : DEFAULT_PATHS.map((entry) => ({ ...entry, deny: [...entry.deny] }));
      }
    }
  }

  if (value.confirmDestructive !== undefined) {
    if (!isRecord(value.confirmDestructive)) {
      warnings.push("Invalid confirmDestructive section; using defaults.");
    } else {
      const keys = ["clearSession", "switchWithUnsavedWork", "forkSession", "blockWithoutUI"] as const;
      for (const key of keys) {
        const setting = value.confirmDestructive[key];
        if (setting === undefined) continue;
        if (typeof setting === "boolean") {
          config.confirmDestructive[key] = setting;
        } else {
          warnings.push(`confirmDestructive.${key} must be a boolean; using true.`);
        }
      }
    }
  }

  if (value.dropMalformedToolCalls !== undefined) {
    if (typeof value.dropMalformedToolCalls === "boolean") {
      config.dropMalformedToolCalls = value.dropMalformedToolCalls;
    } else {
      warnings.push("dropMalformedToolCalls must be a boolean; using true.");
    }
  }

  return { config, warnings };
}

export function loadGuardianConfig(): { config: GuardianConfig; warnings: string[] } {
  const file = configPath();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseGuardianConfig(undefined);
    return {
      config: cloneDefaults(),
      warnings: [`Could not read ${file}; using defaults.`],
    };
  }

  try {
    return parseGuardianConfig(JSON.parse(raw));
  } catch {
    return {
      config: cloneDefaults(),
      warnings: [`Invalid JSON in ${file}; using defaults.`],
    };
  }
}
