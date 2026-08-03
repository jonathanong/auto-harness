import type { AgentConfig, AgentIdentity } from "./config-types.ts";
import { fetchAgentHostConfig, type FetchHostConfigDeps } from "./bootstrap.ts";
import { parseAgentConfig } from "./config-parse.ts";

export type {
  AgentConfig,
  AgentIdentity,
  CommandProfileConfig,
  RepositoryConfig,
  WorktreeConfig,
} from "./config-types.ts";
export { findRepository, findWorktree } from "./config-types.ts";
export { parseAgentConfig } from "./config-parse.ts";
export { fetchAgentHostConfig, httpBaseFromApiUrl } from "./bootstrap.ts";

/**
 * Load process identity from environment.
 * Required: HARNESS_AGENT_ID, HARNESS_API_URL.
 * Optional: HARNESS_API_KEY, HARNESS_LOG_LEVEL.
 */
export function loadAgentIdentity(env: NodeJS.ProcessEnv = process.env): AgentIdentity {
  const agentId = env.HARNESS_AGENT_ID?.trim();
  const apiUrl = env.HARNESS_API_URL?.trim();
  if (!agentId) {
    throw new Error("HARNESS_AGENT_ID is required");
  }
  if (!apiUrl) {
    throw new Error("HARNESS_API_URL is required");
  }
  const logLevelRaw = env.HARNESS_LOG_LEVEL;
  const logLevel =
    logLevelRaw === "debug" ||
    logLevelRaw === "info" ||
    logLevelRaw === "warn" ||
    logLevelRaw === "error"
      ? logLevelRaw
      : "info";
  const identity: AgentIdentity = { agentId, apiUrl, logLevel };
  if (env.HARNESS_API_KEY) {
    identity.apiKey = env.HARNESS_API_KEY;
  }
  return identity;
}

export type LoadConfigOptions = {
  env?: NodeJS.ProcessEnv;
  /** Inline full config for tests (skips network bootstrap). */
  inline?: unknown;
  /** Optional fetch override (tests). */
  fetchFn?: typeof fetch;
};

/**
 * Resolve full agent config: env identity + host inventory from control plane.
 * Tests may pass `inline` to skip the API.
 */
export async function loadAgentConfig(options: LoadConfigOptions = {}): Promise<AgentConfig> {
  const env = options.env ?? process.env;
  if (options.inline !== undefined) {
    const config = parseAgentConfig(options.inline);
    if (env.HARNESS_AGENT_ID) {
      config.agentId = env.HARNESS_AGENT_ID;
    }
    if (env.HARNESS_API_URL) {
      config.apiUrl = env.HARNESS_API_URL;
    }
    if (env.HARNESS_API_KEY) {
      config.apiKey = env.HARNESS_API_KEY;
    }
    if (
      env.HARNESS_LOG_LEVEL === "debug" ||
      env.HARNESS_LOG_LEVEL === "info" ||
      env.HARNESS_LOG_LEVEL === "warn" ||
      env.HARNESS_LOG_LEVEL === "error"
    ) {
      config.logLevel = env.HARNESS_LOG_LEVEL;
    }
    return config;
  }

  const identity = loadAgentIdentity(env);
  const deps: FetchHostConfigDeps = {};
  if (options.fetchFn) {
    deps.fetchFn = options.fetchFn;
  }
  return fetchAgentHostConfig(identity, deps);
}
