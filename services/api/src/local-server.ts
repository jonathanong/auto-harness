import { createServer } from "node:http";

import { ControlPlane } from "./control-plane.ts";
import { createControlPlane } from "./create-plane.ts";
import { AuthService } from "./auth.ts";
import { createLocalApp } from "./local-app.ts";
import { resolvePublicBaseUrl, type LocalServerOptions } from "./local-http.ts";
import { LocalScheduler } from "./local-scheduler.ts";
import { MemorySessionStore } from "./memory-store.ts";
import { createSlackLifecycleWorker } from "./slack-runtime.ts";
import { SlackLifecycleWorker } from "./slack-worker.ts";
import { WebhookWorker } from "./webhook-worker.ts";
import { createPlaneWsBridge, type WsHub } from "./ws-hub.ts";
import { attachViewerWsHub, type ViewerWsHub } from "./viewer-ws-hub.ts";

export { createLocalApp } from "./local-app.ts";

export async function startLocalServer(options: LocalServerOptions = {}): Promise<{
  port: number;
  close: () => Promise<void>;
  store: MemorySessionStore;
  plane: ControlPlane;
  ws?: WsHub;
  viewerWs?: ViewerWsHub;
  scheduler: LocalScheduler;
  slackWorker?: SlackLifecycleWorker;
  webhookWorker?: WebhookWorker;
}> {
  const port = options.port ?? 7420;
  const host = options.host ?? "127.0.0.1";
  // Keep the injected authenticator as the source of truth.  Apart from making
  // tests deterministic, this is important for deployments that hydrate
  // accounts before starting the listener: constructing a second AuthService
  // here would silently discard the configured secret/accounts and could make
  // the listener accept the wrong authentication policy.
  const auth = options.authService ?? new AuthService({ mode: options.authMode });
  if (!isLoopback(host) && auth.mode !== "required") {
    throw new Error("non-loopback API bind requires HARNESS_AUTH_MODE=required");
  }
  const enableWs = options.enableWs !== false;
  const wsRateLimit =
    options.wsRateLimitPerSecond ??
    (Number.isInteger(Number(process.env.HARNESS_WS_RATE_LIMIT_PER_SECOND))
      ? Number(process.env.HARNESS_WS_RATE_LIMIT_PER_SECOND)
      : undefined);
  const bridge = enableWs
    ? createPlaneWsBridge({
        ...(wsRateLimit && wsRateLimit > 0 ? { maxMessagesPerSecond: wsRateLimit } : {}),
        ...(options.onRateLimitEvent ? { onRateLimitEvent: options.onRateLimitEvent } : {}),
      })
    : null;

  let plane = options.plane;
  let store = options.store;

  const publicBaseUrl = resolvePublicBaseUrl(options.publicBaseUrl);
  if (!plane && !store && options.useDynamo !== false) {
    const created = await createControlPlane({
      publicBaseUrl,
    });
    plane = created.plane;
    store = new MemorySessionStore({ plane });
  } else if (!plane && store) {
    plane = store.plane;
  } else if (!plane) {
    plane = new ControlPlane({
      publicBaseUrl,
    });
    store = new MemorySessionStore({ plane });
  }

  if (bridge || options.onHostMessage) {
    plane.setOnHostMessage((hostId, msg) => {
      options.onHostMessage?.(hostId, msg);
      bridge?.onHostMessage(hostId, msg);
    });
  }

  const app = createLocalApp({
    ...options,
    authService: auth,
    plane,
    store: store ?? new MemorySessionStore({ plane }),
    publicBaseUrl,
  });
  const { store: resolvedStore, plane: resolvedPlane, handler } = app;
  await auth.hydrate(resolvedPlane.state.storage);
  const scheduler = new LocalScheduler(resolvedPlane, options.scheduler);
  const slackWorker = createSlackWorker(resolvedPlane, options);
  const webhookWorker = createWebhookWorker(resolvedPlane, options);
  const server = createServer((req, res) => {
    void handler(req, res);
  });

  const wsHub = bridge ? bridge.attach(server, resolvedPlane, auth) : undefined;
  const viewerWsHub = enableWs ? attachViewerWsHub(server, resolvedPlane, auth) : undefined;

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => {
      resolve();
    });
    server.on("error", reject);
  });

  scheduler.start();
  slackWorker?.start();
  webhookWorker?.start();

  return {
    port,
    store: resolvedStore,
    plane: resolvedPlane,
    scheduler,
    ...(slackWorker ? { slackWorker } : {}),
    ...(webhookWorker ? { webhookWorker } : {}),
    ...(wsHub !== undefined ? { ws: wsHub } : {}),
    ...(viewerWsHub !== undefined ? { viewerWs: viewerWsHub } : {}),
    close: async () => {
      await slackWorker?.stop();
      await webhookWorker?.stop();
      await scheduler.stop();
      await new Promise<void>((resolve, reject) => {
        wsHub?.close();
        viewerWsHub?.close();
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function createWebhookWorker(
  plane: ControlPlane,
  options: LocalServerOptions,
): WebhookWorker | undefined {
  const storage = plane.state.storage;
  if (!storage || !options.webhookDestinationSelector || !options.webhookTransport) {
    return undefined;
  }
  return new WebhookWorker(
    {
      store: storage,
      transport: options.webhookTransport,
      selectDestinations: options.webhookDestinationSelector,
      listSessions: async () => plane.listSessions(),
    },
    options.webhookWorker,
  );
}

function createSlackWorker(
  plane: ControlPlane,
  options: LocalServerOptions,
): SlackLifecycleWorker | undefined {
  return createSlackLifecycleWorker(plane, {
    ...(options.slackTransport ? { transport: options.slackTransport } : {}),
    ...(options.slackWorker ? { worker: options.slackWorker } : {}),
  });
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
