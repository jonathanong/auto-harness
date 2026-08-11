import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { AuthService } from "./auth.ts";
import { authorize } from "./auth-policy.ts";
import { ControlPlane } from "./control-plane.ts";
import { createControlPlane } from "./create-plane.ts";
import { applyLocalCors } from "./local-cors.ts";
import { type LocalServerOptions, send } from "./local-http.ts";
import { handleAuthRoutes } from "./local-routes-auth.ts";
import { handleHostInventoryRoutes } from "./local-routes-host-inventory.ts";
import { handleHostSchedulerRoutes } from "./local-routes-host-scheduler.ts";
import { handleCommandRoutes } from "./local-routes-commands.ts";
import { handleProviderAccountRoutes } from "./local-routes-provider-accounts.ts";
import { handleProviderRoutes } from "./local-routes-providers.ts";
import { handleRepositoryRoutes, handleScheduleRoutes } from "./local-routes-repos-schedules.ts";
import { handleSessionRoutes } from "./local-routes-sessions.ts";
import { handleSessionTargetRoutes } from "./local-routes-session-targets.ts";
import { MemorySessionStore } from "./memory-store.ts";
import { createPlaneWsBridge, type WsHub } from "./ws-hub.ts";
import { attachViewerWsHub, type ViewerWsHub } from "./viewer-ws-hub.ts";

export function createLocalApp(options: LocalServerOptions = {}): {
  store: MemorySessionStore;
  plane: ControlPlane;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} {
  const auth = options.authService ?? new AuthService({ mode: options.authMode });
  const plane =
    options.plane ??
    options.store?.plane ??
    new ControlPlane({
      publicBaseUrl: options.publicBaseUrl ?? "http://localhost:7421",
    });
  const store = options.store ?? new MemorySessionStore({ plane });

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Browser UIs on :7421 / :7422 call this API on :7420 — allow local CORS.
    if (applyLocalCors(req, res)) {
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const ctx: import("./local-http.ts").RouteCtx = { plane, req, res, url, method };

    if (method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true });
      return;
    }

    const authRoute = url.pathname.startsWith("/api/v1/auth/");
    const sessionRoute =
      url.pathname === "/api/v1/auth/login" || url.pathname === "/api/v1/auth/logout";
    const selfServiceAuthRoute =
      url.pathname === "/api/v1/auth/me" || url.pathname === "/api/v1/auth/password";
    if (sessionRoute && (await handleAuthRoutes({ auth, ...ctx }))) return;

    if (auth.mode === "required") {
      const principal = await auth.authenticate(req);
      if (!principal) {
        send(res, 401, { error: { code: "UNAUTHENTICATED", message: "authentication required" } });
        return;
      }
      if (!selfServiceAuthRoute && !authorize(principal, method, url.pathname)) {
        send(res, 403, {
          error: { code: "FORBIDDEN", message: "insufficient role for this operation" },
        });
        return;
      }
      ctx.principal = principal;
    } else if (selfServiceAuthRoute) {
      const principal = await auth.authenticate(req);
      if (principal) ctx.principal = principal;
    }
    if (authRoute && (await handleAuthRoutes({ auth, ...ctx }))) return;

    if (await handleSessionRoutes(ctx)) {
      return;
    }
    if (await handleRepositoryRoutes(ctx)) {
      return;
    }
    if (await handleScheduleRoutes(ctx)) {
      return;
    }
    if (await handleHostSchedulerRoutes(ctx)) {
      return;
    }
    if (await handleHostInventoryRoutes(ctx)) {
      return;
    }
    if (await handleProviderRoutes(ctx)) {
      return;
    }
    if (await handleProviderAccountRoutes(ctx)) {
      return;
    }
    if (await handleCommandRoutes(ctx)) {
      return;
    }
    if (await handleSessionTargetRoutes(ctx)) {
      return;
    }

    send(res, 404, { error: { code: "NOT_FOUND", message: "not found" } });
  };

  return { store, plane, handler };
}

export async function startLocalServer(options: LocalServerOptions = {}): Promise<{
  port: number;
  close: () => Promise<void>;
  store: MemorySessionStore;
  plane: ControlPlane;
  ws?: WsHub;
  viewerWs?: ViewerWsHub;
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
  const bridge = enableWs ? createPlaneWsBridge() : null;

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
  const server = createServer((req, res) => {
    void handler(req, res);
  });

  const wsHub = bridge ? bridge.attach(server, resolvedPlane, auth) : undefined;
  const viewerWsHub = bridge ? attachViewerWsHub(server, resolvedPlane, auth) : undefined;

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => {
      resolve();
    });
    server.on("error", reject);
  });

  return {
    port,
    store: resolvedStore,
    plane: resolvedPlane,
    ...(wsHub !== undefined ? { ws: wsHub } : {}),
    ...(viewerWsHub !== undefined ? { viewerWs: viewerWsHub } : {}),
    close: () =>
      new Promise((resolve, reject) => {
        wsHub?.close();
        viewerWsHub?.close();
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
