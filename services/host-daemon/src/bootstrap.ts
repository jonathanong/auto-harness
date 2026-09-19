import { thrownMessage } from "@auto-harness/shared";
import type { DaemonConfig, HostIdentity } from "./config-types.ts";
import { assertDaemonPathsAllowed } from "./allowed-roots.ts";
import { parseDaemonConfig } from "./config-parse.ts";
import { WorkspaceManager } from "./workspace-manager.ts";

/** Normalize control-plane base to HTTP origin (strip trailing slash). */
export function httpBaseFromApiUrl(apiUrl: string): string {
  const base = apiUrl.trim();
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`invalid control-plane URL: ${base}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`HARNESS_API_URL must be an HTTP(S) origin, got ${url.protocol}`);
  }
  if (url.pathname === "/ws" || url.pathname.startsWith("/ws/")) {
    throw new Error("HARNESS_API_URL must not include the /ws path");
  }
  return `${url.origin}${url.pathname}`.replace(/\/$/, "") || url.origin;
}

export type FetchHostInventoryDeps = {
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
};

/** A fetched inventory is syntactically valid but unsafe under its allowed-roots policy. */
export class HostInventoryPolicyError extends Error {
  readonly allowedRoots: string[] | undefined;

  constructor(cause: unknown, allowedRoots?: readonly string[]) {
    super(`host inventory violates its allowed-roots policy: ${thrownMessage(cause)}`);
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
    ...(config.inventoryVersion !== undefined ? { version: config.inventoryVersion } : {}),
    ...(config.setupScript !== undefined ? { setupScript: config.setupScript } : {}),
    ...(config.setupCacheInputs !== undefined ? { setupCacheInputs: config.setupCacheInputs } : {}),
    ...(config.setupCacheHostInputs !== undefined
      ? { setupCacheHostInputs: config.setupCacheHostInputs }
      : {}),
    ...(config.allowedRoots !== undefined ? { allowedRoots: config.allowedRoots } : {}),
    ...(config.updateConfig !== undefined ? { updateConfig: config.updateConfig } : {}),
    ...(config.workspacePools !== undefined ? { workspacePools: config.workspacePools } : {}),
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
  const res = await fetchFn(url, {
    headers,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
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
    // Repository inventory permits an unrestricted legacy host, but a
    // destructive non-git workspace must always have a real, strict root.
    await new WorkspaceManager(config).ensureAll();
  } catch (error) {
    throw new HostInventoryPolicyError(error, config.allowedRoots);
  }
  return config;
}
