import { LOCAL_HOST_ID, LOCAL_API_HTTP } from "@auto-harness/shared";

import type { DaemonConfig, HostIdentity } from "./config-types.ts";
import { fetchHostInventory, type FetchHostInventoryDeps } from "./bootstrap.ts";
import { parseDaemonConfig } from "./config-parse.ts";

export type {
  DaemonConfig,
  HostIdentity,
  RepositoryConfig,
  WorktreeConfig,
} from "./config-types.ts";
export { findRepository, findWorktree } from "./config-types.ts";
export { parseDaemonConfig } from "./config-parse.ts";
export {
  emptyDaemonConfig,
  fetchHostInventory,
  httpBaseFromApiUrl,
  inventoryFingerprint,
} from "./bootstrap.ts";

/**
 * Load process identity from environment.
 * Local defaults: HARNESS_HOST_ID=local-1, HARNESS_API_URL=http://127.0.0.1:7420
 * (HARNESS_API_HTTP is accepted as an alias for the API base).
 * Optional: HARNESS_API_KEY.
 */
export function loadHostIdentity(env: NodeJS.ProcessEnv = process.env): HostIdentity {
  const hostId = env.HARNESS_HOST_ID?.trim() || LOCAL_HOST_ID;
  const apiUrl = env.HARNESS_API_URL?.trim() || env.HARNESS_API_HTTP?.trim() || LOCAL_API_HTTP;
  const identity: HostIdentity = { hostId, apiUrl };
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
export async function loadDaemonConfig(options: LoadConfigOptions = {}): Promise<DaemonConfig> {
  const env = options.env ?? process.env;
  if (options.inline !== undefined) {
    const config = parseDaemonConfig(options.inline);
    if (env.HARNESS_HOST_ID) {
      config.hostId = env.HARNESS_HOST_ID;
    }
    if (env.HARNESS_API_URL) {
      config.apiUrl = env.HARNESS_API_URL;
    }
    if (env.HARNESS_API_KEY) {
      config.apiKey = env.HARNESS_API_KEY;
    }
    return config;
  }

  const identity = loadHostIdentity(env);
  const deps: FetchHostInventoryDeps = {};
  if (options.fetchFn) {
    deps.fetchFn = options.fetchFn;
  }
  return fetchHostInventory(identity, deps);
}
