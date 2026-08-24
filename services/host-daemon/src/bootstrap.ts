import type { DaemonConfig, HostIdentity } from "./config-types.ts";
import { assertDaemonPathsAllowed } from "./allowed-roots.ts";
import { parseDaemonConfig } from "./config-parse.ts";

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

export type FetchHostInventoryDeps = {
  fetchFn?: typeof fetch;
};

/** A fetched inventory is syntactically valid but unsafe under its allowed-roots policy. */
export class HostInventoryPolicyError extends Error {
  readonly allowedRoots: string[] | undefined;

  constructor(cause: unknown, allowedRoots?: readonly string[]) {
    super(
      `host inventory violates its allowed-roots policy: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "HostInventoryPolicyError";
    this.allowedRoots = allowedRoots === undefined ? undefined : [...allowedRoots];
  }
}

/** Identity only — no host inventory yet (register first, attach repos via UI). */
export function emptyDaemonConfig(identity: HostIdentity): DaemonConfig {
  const config: DaemonConfig = {
    hostId: identity.hostId,
    apiUrl: identity.apiUrl,
    repositories: [],
    providerAccounts: [],
  };
  if (identity.apiKey) {
    config.apiKey = identity.apiKey;
  }
  return config;
}

/** Stable fingerprint of host inventory for change detection. */
export function inventoryFingerprint(config: DaemonConfig): string {
  return JSON.stringify({
    ...(config.setupScript !== undefined ? { setupScript: config.setupScript } : {}),
    ...(config.allowedRoots !== undefined ? { allowedRoots: config.allowedRoots } : {}),
    repositories: config.repositories,
  });
}

/**
 * Load host inventory from the control plane.
 * `GET /api/v1/hosts/:hostId/inventory`
 * Missing config (404) → empty inventory so the agent can register first.
 */
export async function fetchHostInventory(
  identity: HostIdentity,
  deps: FetchHostInventoryDeps = {},
): Promise<DaemonConfig> {
  const fetchFn = deps.fetchFn ?? fetch;
  const base = httpBaseFromApiUrl(identity.apiUrl);
  const url = `${base}/api/v1/hosts/${encodeURIComponent(identity.hostId)}/inventory`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (identity.apiKey) {
    headers.authorization = `Bearer ${identity.apiKey}`;
  }
  const res = await fetchFn(url, { headers });
  if (res.status === 404) {
    return emptyDaemonConfig(identity);
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
  const config = parseDaemonConfig(raw, { allowEmptyRepositories: true });
  config.apiUrl = identity.apiUrl;
  if (identity.apiKey) {
    config.apiKey = identity.apiKey;
  }
  try {
    await assertDaemonPathsAllowed(config);
  } catch (error) {
    throw new HostInventoryPolicyError(error, config.allowedRoots);
  }
  return config;
}
