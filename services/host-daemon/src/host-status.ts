import { httpBaseFromApiUrl } from "./bootstrap.ts";
import type { HostIdentity } from "./config.ts";

export type ControlPlaneHostStatus = {
  reachable: boolean;
  hostId: string;
  online: boolean | null;
  connectedAt: string | null;
  draining: boolean | null;
  daemonVersion?: string;
  gitVersion?: string;
  gitReady: boolean | null;
  gitReadinessReason?: string;
  reason: string;
};

type HostRecord = {
  hostId?: unknown;
  online?: unknown;
  connectedAt?: unknown;
  draining?: unknown;
  daemonVersion?: unknown;
  gitVersion?: unknown;
  gitReady?: unknown;
  gitReadinessReason?: unknown;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 256) : undefined;
}

function optionalTimestamp(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, 256) : null;
}

function offlineStatus(identity: HostIdentity, reason: string): ControlPlaneHostStatus {
  return {
    reachable: false,
    hostId: identity.hostId,
    online: null,
    connectedAt: null,
    draining: null,
    gitReady: null,
    reason,
  };
}

export async function fetchControlPlaneHostStatus(
  identity: HostIdentity,
  fetchFn: typeof fetch = fetch,
): Promise<ControlPlaneHostStatus> {
  const url = `${httpBaseFromApiUrl(identity.apiUrl)}/api/v1/hosts`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (identity.apiKey) headers.authorization = `Bearer ${identity.apiKey}`;
  let response: Response;
  try {
    response = await fetchFn(url, { headers });
  } catch {
    return offlineStatus(identity, "control plane is unreachable");
  }
  if (!response.ok) return offlineStatus(identity, "control plane request failed");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return offlineStatus(identity, "control plane returned invalid host status");
  }
  const items =
    typeof body === "object" && body !== null && Array.isArray((body as { items?: unknown }).items)
      ? ((body as { items: unknown[] }).items as HostRecord[])
      : [];
  const host = items.find(
    (item): item is HostRecord =>
      typeof item === "object" && item !== null && item.hostId === identity.hostId,
  );
  if (!host) {
    return {
      reachable: true,
      hostId: identity.hostId,
      online: null,
      connectedAt: null,
      draining: null,
      gitReady: null,
      reason: "exact host is absent from the control plane",
    };
  }
  const result: ControlPlaneHostStatus = {
    reachable: true,
    hostId: identity.hostId,
    online: typeof host.online === "boolean" ? host.online : null,
    connectedAt: optionalTimestamp(host.connectedAt),
    draining: typeof host.draining === "boolean" ? host.draining : null,
    gitReady: typeof host.gitReady === "boolean" ? host.gitReady : null,
    reason: "host status received",
  };
  const daemonVersion = optionalString(host.daemonVersion);
  const gitVersion = optionalString(host.gitVersion);
  const gitReadinessReason = optionalString(host.gitReadinessReason);
  if (daemonVersion) result.daemonVersion = daemonVersion;
  if (gitVersion) result.gitVersion = gitVersion;
  if (gitReadinessReason) result.gitReadinessReason = gitReadinessReason;
  return result;
}
