import type { ControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";
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
    const result = await enqueueSlackDeliveries(
      input.store,
      planSlackLifecycle({
        event,
        session: input.session,
        channel: input.config.defaultChannel,
        notifications: input.config.notifications,
        now: input.now,
      }),
    );
    created += result.created;
    existing += result.existing;
  }
  return { created, existing };
}

/**
 * REST/WS/cron session writers enqueue here so a short-lived session is in the
 * outbox even if another worker never observed it as queued/running.
 */
export async function enqueueSlackSessionLifecycle(
  state: Pick<
    ControlPlaneState,
    "storage" | "slackIntegration" | "now" | "repositories" | "logs" | "publicBaseUrl"
  >,
  session: SessionRecord,
): Promise<void> {
  const storage = state.storage;
  if (!storage || typeof storage.enqueue !== "function") return;
  const record = await loadSlackRecord(state, storage);
  if (!record?.enabled) return;
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
  state: Pick<ControlPlaneState, "slackIntegration">,
  storage: NonNullable<ControlPlaneState["storage"]>,
): Promise<SlackIntegrationRecord | null> {
  if (typeof storage.getSlackIntegration === "function") {
    return storage.getSlackIntegration();
  }
  return state.slackIntegration ?? null;
}

export function slackSessionSnapshot(
  state: Pick<ControlPlaneState, "repositories" | "logs" | "publicBaseUrl">,
  session: SessionRecord,
): SlackSessionSnapshot {
  const repository = state.repositories.get(session.repositoryId);
  const sourceActor = stringMetadata(session.metadata, "sourceActor");
  const targetIndex = session.resolvedRoute?.targetIndex ?? 0;
  return {
    id: session.id,
    repositoryName: repository?.name ?? session.repositoryId,
    prompt: session.prompt,
    commandLabel: session.targetLabels[targetIndex] ?? session.targetLabels[0] ?? "Unknown",
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
  logs: Array<{ stream: string; content: string }> | undefined,
): string[] | undefined {
  const lines = (logs ?? [])
    .filter(({ stream }) => stream === "stderr")
    .flatMap(({ content }) => content.split(/\r?\n/u))
    .filter(Boolean)
    .slice(-5);
  return lines.length ? lines : undefined;
}
