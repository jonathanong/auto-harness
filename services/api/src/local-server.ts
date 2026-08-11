import { createServer } from "node:http";

import { ControlPlane } from "./control-plane.ts";
import { createControlPlane } from "./create-plane.ts";
import { AuthService } from "./auth.ts";
import { createLocalApp } from "./local-app.ts";
import type { LocalServerOptions } from "./local-http.ts";
import { LocalScheduler } from "./local-scheduler.ts";
import { MemorySessionStore } from "./memory-store.ts";
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

  if (!plane && !store && options.useDynamo !== false) {
    const created = await createControlPlane({
      publicBaseUrl: options.publicBaseUrl ?? "http://localhost:7421",
    });
    plane = created.plane;
    store = new MemorySessionStore({ plane });
  } else if (!plane && store) {
    plane = store.plane;
  } else if (!plane) {
    plane = new ControlPlane({
      publicBaseUrl: options.publicBaseUrl ?? "http://localhost:7421",
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
  });
  const { store: resolvedStore, plane: resolvedPlane, handler } = app;
  await auth.hydrate(resolvedPlane.state.storage);
  const scheduler = new LocalScheduler(resolvedPlane, options.scheduler);
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

  return {
    port,
    store: resolvedStore,
    plane: resolvedPlane,
    scheduler,
    ...(wsHub !== undefined ? { ws: wsHub } : {}),
    ...(viewerWsHub !== undefined ? { viewerWs: viewerWsHub } : {}),
    close: async () => {
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

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
