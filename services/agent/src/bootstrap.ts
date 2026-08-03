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

/**
 * Load host inventory from the control plane.
 * `GET /api/v1/agents/:agentId/config`
 */
export async function fetchAgentHostConfig(
  identity: AgentIdentity,
  deps: FetchHostConfigDeps = {},
): Promise<AgentConfig> {
  const fetchFn = deps.fetchFn ?? fetch;
  const base = httpBaseFromApiUrl(identity.apiUrl);
  const url = `${base}/api/v1/agents/${encodeURIComponent(identity.agentId)}/config`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (identity.apiKey) {
    headers.authorization = `Bearer ${identity.apiKey}`;
  }
  const res = await fetchFn(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `bootstrap failed (${res.status}) GET ${url}: ${text || res.statusText}. ` +
        `Configure host inventory via PUT /api/v1/agents/${identity.agentId}/config (API/UI).`,
    );
  }
  const body = (await res.json()) as unknown;
  const raw =
    typeof body === "object" && body !== null
      ? { ...(body as Record<string, unknown>), agentId: identity.agentId }
      : body;
  const config = parseAgentConfig(raw);
  config.apiUrl = identity.apiUrl;
  if (identity.apiKey) {
    config.apiKey = identity.apiKey;
  }
  // Env log level always wins for local debugging.
  config.logLevel = identity.logLevel;
  return config;
}
