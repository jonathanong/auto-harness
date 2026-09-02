import {
  ACTIVE_SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
  type SessionStatus,
} from "@auto-harness/shared";

import type { ControlPlane } from "./control-plane.ts";
import type { SessionRecord } from "./db/types.ts";
import type {
  SlackOutboxStore,
  SlackSessionSnapshot,
  SlackTransport,
} from "./slack-delivery-types.ts";
import { createSlackHttpTransport, type SlackFetcher } from "./slack-http-transport.ts";
import type { SlackIntegrationRecord } from "./slack-integration-types.ts";
import { resolveSlackBotToken } from "./slack-secrets.ts";
import { slackSessionSnapshot, type SlackLifecycleConfig } from "./slack-session-runtime.ts";
import { SlackLifecycleWorker, type SlackLifecycleWorkerOptions } from "./slack-worker.ts";

const OUTBOX_METHODS = ["enqueue", "claimDue", "get", "complete", "reschedule"] as const;
/** Queue TTL is 8 days; keep a day of slack so a long-queued session still gets a terminal post. */
const SLACK_RECONCILE_WINDOW_MS = 9 * 24 * 60 * 60 * 1000;

export function enableSlackOutbound(plane: ControlPlane): void {
  plane.state.slackOutboundEnabled = true;
}

export function createSlackLifecycleWorker(
  plane: ControlPlane,
  options: {
    transport?: SlackTransport;
    worker?: SlackLifecycleWorkerOptions;
    fetch?: SlackFetcher;
  } = {},
): SlackLifecycleWorker | undefined {
  const storage = plane.state.storage;
  if (!isSlackOutboxStore(storage)) return undefined;
  const transport =
    options.transport ??
    (plane.state.secretEncryptor
      ? createSlackHttpTransport({
          getBotToken: () => currentSlackBotToken(plane),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        })
      : undefined);
  if (!transport) return undefined;
  enableSlackOutbound(plane);
  const trackedActive = new Set<string>();
  return new SlackLifecycleWorker(
    {
      store: storage,
      transport,
      getConfig: () => loadSlackLifecycleConfig(plane),
      listSessions: () => listSlackSessionSnapshots(plane, trackedActive),
    },
    options.worker,
  );
}

async function currentSlackBotToken(plane: ControlPlane): Promise<string | null> {
  const record = await loadSlackRecord(plane);
  return record ? resolveSlackBotToken(plane.state.secretEncryptor, record) : null;
}

async function loadSlackLifecycleConfig(plane: ControlPlane): Promise<SlackLifecycleConfig | null> {
  const record = await loadSlackRecord(plane);
  return record
    ? {
        enabled: record.enabled,
        defaultChannel: record.defaultChannel,
        notifications: record.notifications,
      }
    : null;
}

async function loadSlackRecord(plane: ControlPlane): Promise<SlackIntegrationRecord | null> {
  const storage = plane.state.storage;
  if (storage && typeof storage.getSlackIntegration === "function") {
    return storage.getSlackIntegration();
  }
  return plane.state.slackIntegration ?? null;
}

async function listSlackSessionSnapshots(
  plane: ControlPlane,
  trackedActive: Set<string>,
): Promise<SlackSessionSnapshot[]> {
  const sessions = await loadReconcileSessions(plane, trackedActive);
  const nowMs = Date.parse(plane.state.now());
  const snapshots: SlackSessionSnapshot[] = [];
  for (const session of sessions.values()) {
    if (!shouldReconcile(session, nowMs)) continue;
    await hydrateSlackSnapshotInputs(plane, session);
    snapshots.push(slackSessionSnapshot(plane.state, session));
  }
  return snapshots;
}

async function loadReconcileSessions(
  plane: ControlPlane,
  trackedActive: Set<string>,
): Promise<Map<string, SessionRecord>> {
  const sessions = new Map(plane.state.sessions);
  const storage = plane.state.storage;
  const active = await loadActiveSessions(plane);
  for (const [id, session] of active) sessions.set(id, session);
  if (storage && typeof storage.getSession === "function") {
    for (const id of trackedActive) {
      if (active.has(id)) continue;
      const latest = await storage.getSession(id);
      if (latest) sessions.set(id, latest);
    }
  }
  trackedActive.clear();
  for (const [id, session] of sessions) {
    if (session.status === "queued" || session.status === "running") trackedActive.add(id);
  }
  return sessions;
}

async function loadActiveSessions(plane: ControlPlane): Promise<Map<string, SessionRecord>> {
  const storage = plane.state.storage;
  const sessions = new Map<string, SessionRecord>();
  if (storage && typeof storage.listSessionsByStatus === "function") {
    const pages = await Promise.all(
      ACTIVE_SESSION_STATUSES.flatMap((status) =>
        [...Array(plane.state.shardCount).keys()].map((shard) =>
          storage.listSessionsByStatus(status, shard),
        ),
      ),
    );
    for (const session of pages.flat()) sessions.set(session.id, session);
    return sessions;
  }
  const listed =
    storage && typeof storage.listAllSessions === "function"
      ? await storage.listAllSessions()
      : [...plane.state.sessions.values()];
  for (const session of listed) {
    if (session.status === "queued" || session.status === "running")
      sessions.set(session.id, session);
  }
  return sessions;
}

function shouldReconcile(session: SessionRecord, nowMs: number): boolean {
  if (session.status === "queued" || session.status === "running") return true;
  if (!(TERMINAL_SESSION_STATUSES as readonly SessionStatus[]).includes(session.status)) {
    return false;
  }
  const at = Date.parse(session.completedAt ?? session.createdAt);
  return Number.isFinite(at) && at >= nowMs - SLACK_RECONCILE_WINDOW_MS;
}

async function hydrateSlackSnapshotInputs(
  plane: ControlPlane,
  session: SessionRecord,
): Promise<void> {
  const storage = plane.state.storage;
  if (!plane.state.repositories.has(session.repositoryId) && storage?.getRepository) {
    const repository = await storage.getRepository(session.repositoryId);
    if (repository) plane.state.repositories.set(repository.id, repository);
  }
  const failed = session.status === "failed" || session.status === "timed_out";
  if (
    failed &&
    !plane.state.logs.has(session.id) &&
    storage &&
    typeof storage.listLogs === "function"
  ) {
    // consistentRead: true — see the identical fetch (and its full rationale) in
    // ensureFailedSessionLogsLoaded, slack-session-runtime.ts. This result feeds the same
    // immutable outbox rows, so it needs the same guarantee against a racing eventually
    // consistent read missing the host's last session:log write.
    plane.state.logs.set(session.id, await storage.listLogs(session.id, true));
  }
}

function isSlackOutboxStore(storage: unknown): storage is SlackOutboxStore {
  if (!storage || typeof storage !== "object") return false;
  const candidate = storage as Record<string, unknown>;
  return OUTBOX_METHODS.every((method) => typeof candidate[method] === "function");
}
