import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { ControlPlane } from "./control-plane.ts";
import { createControlPlane } from "./create-plane.ts";
import { applyLocalCors } from "./local-cors.ts";
import { type LocalServerOptions, send } from "./local-http.ts";
import { handleAgentConfigRoutes } from "./local-routes-agent-config.ts";
import { handleAgentSchedulerRoutes } from "./local-routes-agent-scheduler.ts";
import { handleCommandRoutes } from "./local-routes-commands.ts";
import { handleProviderAccountRoutes } from "./local-routes-provider-accounts.ts";
import { handleProviderRoutes } from "./local-routes-providers.ts";
import { handleRepositoryRoutes, handleScheduleRoutes } from "./local-routes-repos-schedules.ts";
import { handleSessionRoutes } from "./local-routes-sessions.ts";
import { MemorySessionStore } from "./memory-store.ts";
import { createPlaneWsBridge, type WsHub } from "./ws-hub.ts";

export function createLocalApp(options: LocalServerOptions = {}): {
  store: MemorySessionStore;
  plane: ControlPlane;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} {
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
    const ctx = { plane, req, res, url, method };

    if (method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true });
      return;
    }

    if (await handleSessionRoutes(ctx)) {
      return;
    }
    if (await handleRepositoryRoutes(ctx)) {
      return;
    }
    if (await handleScheduleRoutes(ctx)) {
      return;
    }
    if (await handleAgentSchedulerRoutes(ctx)) {
      return;
    }
    if (await handleAgentConfigRoutes(ctx)) {
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
}> {
  const port = options.port ?? 7420;
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

  if (bridge || options.onAgentMessage) {
    plane.setOnAgentMessage((agentId, msg) => {
      options.onAgentMessage?.(agentId, msg);
      bridge?.onAgentMessage(agentId, msg);
    });
  }

  const app = createLocalApp({
    ...options,
    plane,
    store: store ?? new MemorySessionStore({ plane }),
  });
  const { store: resolvedStore, plane: resolvedPlane, handler } = app;
  const server = createServer((req, res) => {
    void handler(req, res);
  });

  const wsHub = bridge ? bridge.attach(server, resolvedPlane) : undefined;

  await new Promise<void>((resolve, reject) => {
    server.listen(port, () => {
      resolve();
    });
    server.on("error", reject);
  });

  return {
    port,
    store: resolvedStore,
    plane: resolvedPlane,
    ...(wsHub !== undefined ? { ws: wsHub } : {}),
    close: () =>
      new Promise((resolve, reject) => {
        wsHub?.close();
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
