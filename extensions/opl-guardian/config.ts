import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type Op = "read" | "write" | "edit" | "bash";

export interface PathEntry {
  path: string;
  deny: Op[];
}

export interface GuardianLogging {
  /**
   * Where a malformed-call incident is recorded. Never resolved against the session cwd:
   * forensics in the open repository would be untracked noise holding provider fragments.
   * `null` uses `<agent dir>/guardian-incidents.jsonl`, a relative value resolves under the
   * agent dir, `~` expands to the home directory, and `false` stops writing.
   */
  incidentFile: string | false | null;
  /** Rotate the log to `<file>.1` before an append that would pass this many bytes. */
  maxBytes: number;
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
  logging: GuardianLogging;
}

export const DEFAULT_LOGGING: GuardianLogging = {
  incidentFile: null,
  maxBytes: 256 * 1024,
};

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
  logging: { ...DEFAULT_LOGGING },
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
    logging: { ...DEFAULT_LOGGING },
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

  if (value.logging !== undefined) {
    if (!isRecord(value.logging)) {
      warnings.push("Invalid logging section; using defaults.");
    } else {
      const file = value.logging.incidentFile;
      if (file === undefined || file === null) {
        config.logging.incidentFile = DEFAULT_LOGGING.incidentFile;
      } else if (file === false || typeof file === "string") {
        config.logging.incidentFile = file;
      } else {
        warnings.push("logging.incidentFile must be a path or false; using the agent-directory default.");
      }

      const maxBytes = value.logging.maxBytes;
      if (maxBytes === undefined) {
        config.logging.maxBytes = DEFAULT_LOGGING.maxBytes;
      } else if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes >= 1024) {
        config.logging.maxBytes = Math.floor(maxBytes);
      } else {
        warnings.push("logging.maxBytes must be a number of at least 1024; using the default.");
      }
    }
  }

  return { config, warnings };
}

/**
 * Resolve where incident records go. Absolute paths are used as given, `~/` expands to the
 * home directory, and anything else lands under pi's agent directory - the session cwd is
 * never an input, so opening a repository cannot leave a log file inside it.
 */
export function incidentLogPath(logging: GuardianLogging): string | null {
  if (logging.incidentFile === false) return null;
  const value = logging.incidentFile;
  if (typeof value !== "string" || value.trim() === "") {
    return join(getAgentDir(), "guardian-incidents.jsonl");
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  if (isAbsolute(trimmed)) return trimmed;
  return join(getAgentDir(), trimmed);
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
