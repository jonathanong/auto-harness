import type { SessionRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { readSessionLogObjects } from "./session-log-objects.ts";
import type { SlackIntegrationRecord, SlackNotifications } from "./slack-integration-types.ts";
import { planSlackLifecycle } from "./slack-lifecycle.ts";
import { enqueueSlackDeliveries } from "./slack-outbox.ts";
import type {
  SlackLifecycleEvent,
  SlackOutboxStore,
  SlackSessionSnapshot,
} from "./slack-delivery-types.ts";

export type SlackLifecycleConfig = {
  enabled: boolean;
  defaultChannel: string;
  notifications: SlackNotifications;
};

/** Structural slice of control-plane state — kept local to avoid a circular import. */
type SlackSessionStorage = SlackOutboxStore & {
  getSlackIntegration?: () => Promise<SlackIntegrationRecord | null>;
  getRepository?: (id: string) => Promise<{ id: string; name: string } | null>;
  listLogs?: (
    sessionId: string,
    consistentRead?: boolean,
  ) => Promise<ReadonlyArray<{ stream: string; content: string }>>;
};

type SlackSessionLogCache = {
  get(id: string): ReadonlyArray<{ stream: string; content: string }> | undefined;
  has(id: string): boolean;
  set(id: string, records: ReadonlyArray<{ stream: string; content: string }>): unknown;
};

type SlackSessionRepositoryCache = {
  get(id: string): { name: string } | undefined;
  set(id: string, value: { name: string }): unknown;
};

type SlackSessionWriterState = {
  storage: SlackSessionStorage | undefined;
  slackIntegration: SlackIntegrationRecord | undefined;
  now: () => string;
  repositories: SlackSessionRepositoryCache;
  logs: SlackSessionLogCache;
  publicBaseUrl: string;
};

/**
 * Reconciles all lifecycle operations implied by the current durable snapshot.
 * Stable insert-only operation IDs make this safe after restarts and duplicate sweeps.
 */
export async function reconcileSlackSession(input: {
  store: SlackOutboxStore;
  config: SlackLifecycleConfig | null;
  session: SlackSessionSnapshot;
  now: string;
}): Promise<{ created: number; existing: number }> {
  if (!input.config?.enabled) return { created: 0, existing: 0 };
  let created = 0;
  let existing = 0;
  for (const event of impliedEvents(input.session)) {
    const plan = await planSlackLifecycle({
      event,
      session: input.session,
      channel: input.config.defaultChannel,
      notifications: input.config.notifications,
      now: input.now,
      getDelivery: (id) => input.store.get(id),
    });
    const result = await enqueueSlackDeliveries(input.store, plan);
    created += result.created;
    existing += result.existing;
  }
  return { created, existing };
}

/**
 * Failed snapshots fetch stderr tails from durable logs when the process cache does not
 * already have them (docs/integrations.md's durable-tail promise). The outbox stores one
 * immutable operation ID per lifecycle action, so a terminal row enqueued here with no
 * stderr never gets a second chance — a later reconciliation sweep sees the same ID and
 * cannot replace its text. This must run before every snapshot build, not just the cron
 * reconciliation path: a WS/REST writer on a cold container (no hydration, and this
 * session's own log chunks landed on a different container) would otherwise enqueue the
 * terminal row with an empty tail.
 *
 * Reads with `consistentRead: true`: this result is baked into an immutable outbox row, so
 * an eventually consistent read racing the host's own final `session:log` write — which can
 * legally return a transcript missing that last chunk — would freeze the miss permanently,
 * unlike listLogs's other callers (REST/viewer tail display, archive writes), which get a
 * later read that self-corrects.
 *
 * One known, accepted limitation, shared with the pre-existing cron-path helper this mirrors
 * (hydrateSlackSnapshotInputs in slack-runtime.ts) rather than introduced by it: the `has()`
 * check treats "some cached content" as "complete," so a container that already holds a
 * partial prefix from its own live writes won't refresh from storage even if newer chunks
 * landed on a different container. Fixing that, and bounding `listLogs`'s full-transcript
 * scan for an unusually log-heavy session, both need a reverse-ordered tail query
 * (ScanIndexForward: false) added to the storage layer — real, separate follow-up work, not
 * done here. The try/catch below bounds today's unbounded-scan blast radius in the
 * meantime: a failed fetch drops just the stderr tail, not the entire Slack notification
 * this call sits in front of.
 */
async function ensureFailedSessionLogsLoaded(
  state: SlackSessionWriterState,
  _storage: SlackSessionStorage,
  session: SessionRecord,
): Promise<void> {
  const failed = session.status === "failed" || session.status === "timed_out";
  if (!failed || state.logs.has(session.id)) return;
  try {
    const logs = await readSessionLogObjects(state as ControlPlaneState, session.id);
    if (logs && logs.length > 0) state.logs.set(session.id, logs);
  } catch {
    return;
  }
}

/**
 * `slackSessionSnapshot` reads the repository name from this in-memory cache only, so a
 * cold container — e.g. a host-report terminal write, minutes after session creation, on
 * a different Lambda instance than the one that cached it at session-create time — falls
 * back to the repository id instead of its name (seen in production: the terminal message
 * read the id while the root, cached earlier, still showed the name). Mirrors the cron
 * worker's own hydration (`hydrateSlackSnapshotInputs` in slack-runtime.ts) with the same
 * bounded point read, only performed when the cache actually misses. A failed read
 * degrades to the repository id in the snapshot rather than losing the whole notification,
 * matching the philosophy already documented above for the failed-session stderr tail.
 */
async function ensureRepositoryLoaded(
  state: SlackSessionWriterState,
  storage: SlackSessionStorage,
  repositoryId: string,
): Promise<void> {
  if (state.repositories.get(repositoryId) || typeof storage.getRepository !== "function") {
    return;
  }
  try {
    const repository = await storage.getRepository(repositoryId);
    if (repository) state.repositories.set(repository.id, repository);
  } catch {
    return;
  }
}

/**
 * REST/WS/cron session writers enqueue here so a short-lived session is in the
 * outbox even if another worker never observed it as queued/running.
 */
export async function enqueueSlackSessionLifecycle(
  state: SlackSessionWriterState,
  session: SessionRecord,
): Promise<void> {
  const storage = state.storage;
  if (!storage || typeof storage.enqueue !== "function") return;
  const record = await loadSlackRecord(state, storage);
  if (!record?.enabled) return;
  await ensureFailedSessionLogsLoaded(state, storage, session);
  await ensureRepositoryLoaded(state, storage, session.repositoryId);
  await reconcileSlackSession({
    store: storage,
    config: {
      enabled: record.enabled,
      defaultChannel: record.defaultChannel,
      notifications: record.notifications,
    },
    session: slackSessionSnapshot(state, session),
    now: state.now(),
  });
}

async function loadSlackRecord(
  state: Pick<SlackSessionWriterState, "slackIntegration">,
  storage: SlackSessionStorage,
): Promise<SlackIntegrationRecord | null> {
  if (typeof storage.getSlackIntegration === "function") {
    return storage.getSlackIntegration();
  }
  return state.slackIntegration ?? null;
}

export function slackSessionSnapshot(
  state: Pick<SlackSessionWriterState, "repositories" | "logs" | "publicBaseUrl">,
  session: SessionRecord,
): SlackSessionSnapshot {
  const repository = state.repositories.get(session.repositoryId);
  const sourceActor = stringMetadata(session.metadata, "sourceActor");
  const targetIndex = session.resolvedRoute?.targetIndex ?? 0;
  return {
    id: session.id,
    repositoryName: repository?.name ?? session.repositoryId,
    prompt: session.prompt,
    commandLabel:
      session.targetDisplayNames[targetIndex] ?? session.targetDisplayNames[0] ?? "Unknown",
    priority: session.priority,
    source: session.source ?? "api",
    ...(sourceActor ? { sourceActor } : {}),
    url: `${state.publicBaseUrl}/sessions/${session.id}`,
    status: session.status,
    createdAt: session.createdAt,
    ...(session.startedAt ? { startedAt: session.startedAt } : {}),
    ...(session.completedAt ? { completedAt: session.completedAt } : {}),
    ...(session.hostId !== undefined ? { hostId: session.hostId } : {}),
    ...(session.worktreeId !== undefined ? { worktreeId: session.worktreeId } : {}),
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
    ...(session.errorCode ? { errorCode: session.errorCode } : {}),
    ...(session.errorMessage ? { errorMessage: session.errorMessage } : {}),
    ...(stderrTail(state.logs.get(session.id))
      ? { stderrTail: stderrTail(state.logs.get(session.id)) }
      : {}),
  };
}

function impliedEvents(session: SlackSessionSnapshot): SlackLifecycleEvent[] {
  const events: SlackLifecycleEvent[] = ["session_created"];
  if (session.startedAt || session.status === "running") {
    events.push("session_started");
  }
  if (session.status === "completed") events.push("session_completed");
  if (session.status === "cancelled") events.push("session_cancelled");
  if (session.status === "failed" || session.status === "timed_out") {
    events.push("session_failed");
  }
  return events;
}

function stringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stderrTail(
  logs: ReadonlyArray<{ stream: string; content: string }> | undefined,
): string[] | undefined {
  const lines = (logs ?? [])
    .filter(({ stream }) => stream === "stderr")
    .flatMap(({ content }) => content.split(/\r?\n/u))
    .filter(Boolean)
    .slice(-5);
  return lines.length ? lines : undefined;
}
