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
  return new SlackLifecycleWorker(
    {
      store: storage,
      transport,
      getConfig: () => loadSlackLifecycleConfig(plane),
      listSessions: () => listSlackSessionSnapshots(plane),
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

async function listSlackSessionSnapshots(plane: ControlPlane): Promise<SlackSessionSnapshot[]> {
  const storage = plane.state.storage;
  if (storage && typeof storage.listRepositories === "function") {
    for (const repository of await storage.listRepositories()) {
      plane.state.repositories.set(repository.id, repository);
    }
  }
  const sessions = new Map(plane.state.sessions);
  if (storage && typeof storage.listAllSessions === "function") {
    for (const session of await storage.listAllSessions()) sessions.set(session.id, session);
  }
  return [...sessions.values()].map((session: SessionRecord) =>
    slackSessionSnapshot(plane.state, session),
  );
}

function isSlackOutboxStore(storage: unknown): storage is SlackOutboxStore {
  if (!storage || typeof storage !== "object") return false;
  const candidate = storage as Record<string, unknown>;
  return OUTBOX_METHODS.every((method) => typeof candidate[method] === "function");
}
