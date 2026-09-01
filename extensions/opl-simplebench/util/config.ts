/**
 * Shared test utilities for simplebench extension.
 * Extracted from extensions/simplebench.ts to reduce duplication between
 * Ollama-specific and Provider-specific test variants.
 *
 * @module shared/simplebench-utils
 * @writtenby VTSTech — https://www.vts-tech.org
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// Configuration Constants
// ============================================================================

/**
 * Configuration constants for model testing.
 * Centralized to make tuning and maintenance easier.
 *
 * @property DEFAULT_TIMEOUT_MS - Default timeout for Ollama API calls (~16.7 min)
 * @property CONNECT_TIMEOUT_S - Connection timeout for fetch (seconds)
 * @property MAX_RETRIES - Number of retry attempts for transient failures
 * @property RETRY_DELAY_MS - Delay between retry attempts (milliseconds)
 * @property MIN_THINKING_LENGTH - Minimum characters to consider thinking tokens valid
 * @property TOOL_TEST_TIMEOUT_MS - Timeout for tool usage tests
 * @property TOOL_SUPPORT_TIMEOUT_MS - Timeout for tool support detection
 * @property TAGS_TIMEOUT_MS - Timeout for /api/tags requests
 */
export const CONFIG = {
  // General API settings - standardized across all providers
  DEFAULT_TIMEOUT_MS: 300000,        // 5 minutes - reasonable timeout for all providers
  CONNECT_TIMEOUT_S: 60,             // 60 seconds to establish connection
  MAX_RETRIES: 2,                    // Two retries for transient failures (standardized)
  RETRY_DELAY_MS: 15000,              // 15 seconds between retries (standardized)

  // Test-specific settings - standardized across all providers
  MIN_THINKING_LENGTH: 10,           // Minimum chars to consider thinking tokens valid
  TOOL_TEST_TIMEOUT_MS: 300000,       // 5 minutes - consistent timeout for tool usage tests
  TOOL_SUPPORT_TIMEOUT_MS: 300000,   // 5 minutes - consistent timeout for tool support detection

  // Metadata retrieval
  TAGS_TIMEOUT_MS: 15000,            // 15 seconds for /api/tags
  MODEL_INFO_TIMEOUT_MS: 30000,      // 30 seconds for model info lookup

  // Provider API settings
  PROVIDER_TIMEOUT_MS: 300000,        // 5 minutes - consistent with Ollama
  PROVIDER_TOOL_TIMEOUT_MS: 300000,   // 5 minutes - consistent with Ollama tool tests

  // Context length fetching
  CONTEXT_BATCH_SIZE: 3,             // Concurrent requests when fetching model context lengths

  // Rate limiting
  TEST_DELAY_MS: 4000,              // 4 seconds between tests to avoid rate limiting
} as const;

// ============================================================================
// User Configuration Overrides
// ============================================================================

const TEST_CONFIG_DIR = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
export const TEST_CONFIG_PATH = path.join(TEST_CONFIG_DIR, "configs", "opl-simplebench.json");
const LEGACY_TEST_CONFIG_PATH = path.join(TEST_CONFIG_DIR, "simplebench-config.json");

/** Shape of the user configuration file. */
export interface ModelTestUserConfig {
  defaultTimeoutMs?: number;
  connectTimeoutS?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  testDelayMs?: number;
  toolTestTimeoutMs?: number;
  providerTimeoutMs?: number;
  providerToolTimeoutMs?: number;
  contextBatchSize?: number;
  researchSearchProvider?: "ddgs" | "searxng";
  researchSearchUrl?: string;
  researchMaxResults?: number;
  llamaServerUrl?: string;
  llamagputopUrl?: string;
}

/**
 * Read user configuration from ~/.pi/agent/simplebench-config.json.
 * Returns an empty object if the file doesn't exist or is invalid.
 */
export function readTestConfig(): ModelTestUserConfig {
  try {
    const configPath = fs.existsSync(TEST_CONFIG_PATH) ? TEST_CONFIG_PATH : LEGACY_TEST_CONFIG_PATH;
    if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, "utf-8")) as ModelTestUserConfig;
  } catch { /* config read/parse failure is non-critical — defaults are used */ }
  return {};
}

/**
 * Get effective test configuration by merging user overrides with defaults.
 * User values take precedence over CONFIG defaults.
 */
export function getEffectiveConfig(): typeof CONFIG {
  const userConfig = readTestConfig();
  return {
    ...CONFIG,
    DEFAULT_TIMEOUT_MS: (userConfig.defaultTimeoutMs ?? CONFIG.DEFAULT_TIMEOUT_MS) as typeof CONFIG.DEFAULT_TIMEOUT_MS,
    CONNECT_TIMEOUT_S: (userConfig.connectTimeoutS ?? CONFIG.CONNECT_TIMEOUT_S) as typeof CONFIG.CONNECT_TIMEOUT_S,
    MAX_RETRIES: (userConfig.maxRetries ?? CONFIG.MAX_RETRIES) as typeof CONFIG.MAX_RETRIES,
    RETRY_DELAY_MS: (userConfig.retryDelayMs ?? CONFIG.RETRY_DELAY_MS) as typeof CONFIG.RETRY_DELAY_MS,
    TEST_DELAY_MS: (userConfig.testDelayMs ?? CONFIG.TEST_DELAY_MS) as typeof CONFIG.TEST_DELAY_MS,
    TOOL_TEST_TIMEOUT_MS: (userConfig.toolTestTimeoutMs ?? CONFIG.TOOL_TEST_TIMEOUT_MS) as typeof CONFIG.TOOL_TEST_TIMEOUT_MS,
    PROVIDER_TIMEOUT_MS: (userConfig.providerTimeoutMs ?? CONFIG.PROVIDER_TIMEOUT_MS) as typeof CONFIG.PROVIDER_TIMEOUT_MS,
    PROVIDER_TOOL_TIMEOUT_MS: (userConfig.providerToolTimeoutMs ?? CONFIG.PROVIDER_TOOL_TIMEOUT_MS) as typeof CONFIG.PROVIDER_TOOL_TIMEOUT_MS,
    CONTEXT_BATCH_SIZE: (userConfig.contextBatchSize ?? CONFIG.CONTEXT_BATCH_SIZE) as typeof CONFIG.CONTEXT_BATCH_SIZE,
  };
}

// ============================================================================
// Weather Tool Definition (shared across all tool tests)
// ============================================================================

/**
 * Standard get_weather tool schema used by all tool usage tests.
 * Previously copy-pasted in 3+ places — now a single shared constant.
 */
export const WEATHER_TOOL_DEFINITION = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Get the current weather for a location",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"] },
      },
      required: ["location"],
    },
  },
};

// ============================================================================
// Tool Support Cache (path only — backing file is no longer written)
// ============================================================================

const TOOL_SUPPORT_CACHE_DIR = path.join(os.homedir(), ".pi", "agent", "cache");
export const TOOL_SUPPORT_CACHE_PATH = path.join(TOOL_SUPPORT_CACHE_DIR, "tool_support.json");

// ============================================================================
// ChatFn Abstraction
// ============================================================================

/**
 * Abstraction over Ollama and Provider chat APIs.
 * Callers wrap their specific chat implementation into this shape.
 */
export type ChatMessage = { role: string; content: string; tool_calls?: any[]; tool_call_id?: string };

export function buildToolResultMessages(assistantContent: string, calls: any[], results: string[]): ChatMessage[] {
  const toolCalls = calls.map((call, index) => ({ ...call, id: call.id || `toolcall${index + 1}` }));
  return [
    { role: "assistant", content: assistantContent || "", tool_calls: toolCalls },
    ...toolCalls.map((call, index) => ({ role: "tool", tool_call_id: call.id, content: results[index] || "INVALID_ARGUMENTS" })),
  ];
}

export type ChatFn = (
  model: string,
  messages: ChatMessage[],
  options?: Record<string, unknown>,
) => Promise<{ content: string; toolCalls?: any[]; elapsedMs: number; raw?: any; requestCount?: number; retryCount?: number; startedAt?: string; finishedAt?: string; timeToFirstTokenMs?: number | null }>;

