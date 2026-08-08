import type { AgentConfig, AgentIdentity } from "./config-types.ts";
import { parseAgentConfig } from "./config-parse.ts";

/** Normalize control-plane base to HTTP origin (strip trailing slash and /ws). */
export function httpBaseFromApiUrl(apiUrl: string): string {
  let base = apiUrl.trim();
  if (base.startsWith("ws://")) {
    base = `http://${base.slice("ws://".length)}`;
  } else if (base.startsWith("wss://")) {
    base = `https://${base.slice("wss://".length)}`;
  }
  base = base.replace(/\/$/, "");
  if (base.endsWith("/ws")) {
    base = base.slice(0, -"/ws".length);
  }
  return base.replace(/\/$/, "");
}

export type FetchHostConfigDeps = {
  fetchFn?: typeof fetch;
};

/** Identity only — no host inventory yet (register first, attach repos via UI). */
export function emptyAgentConfig(identity: AgentIdentity): AgentConfig {
  const config: AgentConfig = {
    hostId: identity.hostId,
    apiUrl: identity.apiUrl,
    repositories: [],
    providerAccounts: [],
    commandProfiles: {},
    logLevel: identity.logLevel,
  };
  if (identity.apiKey) {
    config.apiKey = identity.apiKey;
  }
  return config;
}

/** Stable fingerprint of host inventory for change detection. */
export function inventoryFingerprint(config: AgentConfig): string {
  return JSON.stringify({
    repositories: config.repositories,
    commandProfiles: config.commandProfiles,
  });
}

/**
 * Load host inventory from the control plane.
 * `GET /api/v1/hosts/:hostId/inventory`
 * Missing config (404) → empty inventory so the agent can register first.
 */
export async function fetchAgentHostConfig(
  identity: AgentIdentity,
  deps: FetchHostConfigDeps = {},
): Promise<AgentConfig> {
  const fetchFn = deps.fetchFn ?? fetch;
  const base = httpBaseFromApiUrl(identity.apiUrl);
  const url = `${base}/api/v1/hosts/${encodeURIComponent(identity.hostId)}/inventory`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (identity.apiKey) {
    headers.authorization = `Bearer ${identity.apiKey}`;
  }
  const res = await fetchFn(url, { headers });
  if (res.status === 404) {
    return emptyAgentConfig(identity);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`bootstrap failed (${res.status}) GET ${url}: ${text || res.statusText}`);
  }
  const body = (await res.json()) as unknown;
  const raw =
    typeof body === "object" && body !== null
      ? { ...(body as Record<string, unknown>), hostId: identity.hostId }
      : body;
  const config = parseAgentConfig(raw, { allowEmptyRepositories: true });
  config.apiUrl = identity.apiUrl;
  if (identity.apiKey) {
    config.apiKey = identity.apiKey;
  }
  // Env log level always wins for local debugging.
  config.logLevel = identity.logLevel;
  return config;
}
