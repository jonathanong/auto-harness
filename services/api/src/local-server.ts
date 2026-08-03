import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { AgentToServerMessage, AgentWireMessage } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.js";
import { createControlPlane } from "./create-plane.js";
import { MemorySessionStore } from "./memory-store.js";
import { createPlaneWsBridge, type WsHub } from "./ws-hub.js";

type LocalServerOptions = {
  port?: number;
  store?: MemorySessionStore;
  plane?: ControlPlane;
  publicBaseUrl?: string;
  /**
   * When true (default for startLocalServer), open DynamoDB Local and hydrate.
   * Unit tests may pass an in-process plane without DynamoDB.
   */
  useDynamo?: boolean;
  /** Attach /ws agent hub (default true for startLocalServer). */
  enableWs?: boolean;
  onAgentMessage?: (agentId: string, msg: AgentWireMessage) => void;
};

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (status === 204) {
    res.writeHead(204);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createLocalApp(options: LocalServerOptions = {}): {
  store: MemorySessionStore;
  plane: ControlPlane;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} {
  const plane =
    options.plane ??
    options.store?.plane ??
    new ControlPlane({
      publicBaseUrl: options.publicBaseUrl ?? "http://localhost:3000",
    });
  const store = options.store ?? new MemorySessionStore({ plane });

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && url.pathname === "/api/v1/sessions") {
      try {
        const body = await readJson(req);
        const result = plane.createSession(body);
        if (!result.ok) {
          send(res, result.code === "CONFLICT" ? 409 : 400, {
            error: {
              code: result.code ?? "VALIDATION_ERROR",
              message: result.error,
            },
          });
          return;
        }
        send(res, 201, result.session);
        return;
      } catch {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
        });
        return;
      }
    }

    if (method === "GET" && url.pathname === "/api/v1/sessions") {
      send(res, 200, { items: plane.listSessions() });
      return;
    }

    // --- repositories ---
    if (method === "GET" && url.pathname === "/api/v1/repositories") {
      send(res, 200, { items: plane.listRepositories() });
      return;
    }
    if (method === "POST" && url.pathname === "/api/v1/repositories") {
      try {
        const body = (await readJson(req)) as Record<string, unknown>;
        const result = plane.createRepository({
          name: String(body.name ?? ""),
          url: String(body.url ?? ""),
          ...(typeof body.id === "string" ? { id: body.id } : {}),
          ...(typeof body.defaultBranch === "string" ? { defaultBranch: body.defaultBranch } : {}),
          ...(typeof body.setupScript === "string" ? { setupScript: body.setupScript } : {}),
          ...(typeof body.terminalHookScript === "string"
            ? { terminalHookScript: body.terminalHookScript }
            : {}),
        });
        if (!result.ok) {
          send(res, 400, {
            error: { code: "VALIDATION_ERROR", message: result.error },
          });
          return;
        }
        send(res, 201, result.repository);
        return;
      } catch {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
        });
        return;
      }
    }
    const repoMatch = /^\/api\/v1\/repositories\/([^/]+)$/.exec(url.pathname);
    if (repoMatch) {
      const id = repoMatch[1]!;
      if (method === "GET") {
        const repo = plane.getRepository(id);
        if (!repo) {
          send(res, 404, { error: { code: "NOT_FOUND", message: "repository not found" } });
          return;
        }
        send(res, 200, repo);
        return;
      }
      if (method === "PUT" || method === "PATCH") {
        try {
          const body = (await readJson(req)) as Record<string, unknown>;
          const result = plane.updateRepository(id, {
            ...(typeof body.name === "string" ? { name: body.name } : {}),
            ...(typeof body.url === "string" ? { url: body.url } : {}),
            ...(typeof body.defaultBranch === "string"
              ? { defaultBranch: body.defaultBranch }
              : {}),
            ...(typeof body.setupScript === "string" ? { setupScript: body.setupScript } : {}),
            ...(typeof body.terminalHookScript === "string"
              ? { terminalHookScript: body.terminalHookScript }
              : {}),
          });
          if (!result.ok) {
            send(res, 404, { error: { code: "NOT_FOUND", message: result.error } });
            return;
          }
          send(res, 200, result.repository);
          return;
        } catch {
          send(res, 400, {
            error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
          });
          return;
        }
      }
      if (method === "DELETE") {
        const result = plane.deleteRepository(id);
        if (!result.ok) {
          send(res, 404, { error: { code: "NOT_FOUND", message: result.error } });
          return;
        }
        send(res, 204, null);
        return;
      }
    }

    // --- schedules ---
    if (method === "GET" && url.pathname === "/api/v1/schedules") {
      send(res, 200, { items: plane.listSchedules() });
      return;
    }
    if (method === "POST" && url.pathname === "/api/v1/schedules") {
      try {
        const body = (await readJson(req)) as Record<string, unknown>;
        if (
          typeof body.repositoryId !== "string" ||
          typeof body.name !== "string" ||
          typeof body.commandProfile !== "string" ||
          typeof body.cron !== "string" ||
          typeof body.timeout !== "number" ||
          typeof body.nextRunAt !== "string"
        ) {
          send(res, 400, {
            error: {
              code: "VALIDATION_ERROR",
              message: "repositoryId, name, commandProfile, cron, timeout, nextRunAt are required",
            },
          });
          return;
        }
        const rec = plane.putSchedule({
          repositoryId: body.repositoryId,
          name: body.name,
          commandProfile: body.commandProfile,
          cron: body.cron,
          timeout: body.timeout,
          nextRunAt: body.nextRunAt,
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
          ...(typeof body.ref === "string" ? { ref: body.ref } : {}),
          ...(typeof body.id === "string" ? { id: body.id } : {}),
        });
        send(res, 201, rec);
        return;
      } catch {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
        });
        return;
      }
    }
    const schedTrigger = /^\/api\/v1\/schedules\/([^/]+)\/trigger$/.exec(url.pathname);
    if (method === "POST" && schedTrigger) {
      const result = plane.triggerSchedule(schedTrigger[1]!);
      if (!result.ok) {
        send(res, 400, { error: { code: "TRIGGER_ERROR", message: result.error } });
        return;
      }
      send(res, 201, result.session);
      return;
    }
    const schedMatch = /^\/api\/v1\/schedules\/([^/]+)$/.exec(url.pathname);
    if (schedMatch) {
      const id = schedMatch[1]!;
      if (method === "GET") {
        const s = plane.getSchedule(id);
        if (!s) {
          send(res, 404, { error: { code: "NOT_FOUND", message: "schedule not found" } });
          return;
        }
        send(res, 200, s);
        return;
      }
      if (method === "PUT" || method === "PATCH") {
        try {
          const body = (await readJson(req)) as Record<string, unknown>;
          const result = plane.updateSchedule(id, {
            ...(typeof body.name === "string" ? { name: body.name } : {}),
            ...(typeof body.commandProfile === "string"
              ? { commandProfile: body.commandProfile }
              : {}),
            ...(typeof body.cron === "string" ? { cron: body.cron } : {}),
            ...(typeof body.timeout === "number" ? { timeout: body.timeout } : {}),
            ...(typeof body.nextRunAt === "string" ? { nextRunAt: body.nextRunAt } : {}),
            ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
            ...(typeof body.ref === "string" ? { ref: body.ref } : {}),
            ...(typeof body.repositoryId === "string" ? { repositoryId: body.repositoryId } : {}),
          });
          if (!result.ok) {
            send(res, 404, { error: { code: "NOT_FOUND", message: result.error } });
            return;
          }
          send(res, 200, result.schedule);
          return;
        } catch {
          send(res, 400, {
            error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
          });
          return;
        }
      }
      if (method === "DELETE") {
        const result = plane.deleteSchedule(id);
        if (!result.ok) {
          send(res, 404, { error: { code: "NOT_FOUND", message: result.error } });
          return;
        }
        send(res, 204, null);
        return;
      }
    }

    // --- session cancel ---
    const cancelMatch = /^\/api\/v1\/sessions\/([^/]+)\/cancel$/.exec(url.pathname);
    if (method === "POST" && cancelMatch) {
      const result = plane.cancelSession(cancelMatch[1]!);
      if (!result.ok) {
        send(res, 400, { error: { code: "CANCEL_ERROR", message: result.error } });
        return;
      }
      send(res, 200, result.session);
      return;
    }

    if (method === "GET" && url.pathname === "/api/v1/agents") {
      send(res, 200, { items: plane.listAgents() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/v1/command-profiles") {
      send(res, 200, { items: plane.listCommandProfiles() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/v1/worktrees") {
      send(res, 200, { items: plane.listWorktrees() });
      return;
    }

    if (method === "POST" && url.pathname === "/api/v1/agent/messages") {
      try {
        const body = (await readJson(req)) as AgentToServerMessage;
        const result = plane.handleAgentMessage(body);
        if (!result.ok) {
          send(res, 400, {
            error: { code: "AGENT_MESSAGE_ERROR", message: result.error },
          });
          return;
        }
        send(res, 200, { ok: true });
        return;
      } catch {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
        });
        return;
      }
    }

    if (method === "POST" && url.pathname === "/api/v1/scheduler/assign") {
      const assigned = plane.assignQueued();
      send(res, 200, {
        items: assigned.map((a) => ({
          sessionId: a.session.id,
          worktreeId: a.worktree.id,
          agentId: a.worktree.agentId,
        })),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/v1/scheduler/ack-deadlines") {
      const requeued = plane.enforceAckDeadlines();
      send(res, 200, { requeued });
      return;
    }

    if (method === "POST" && url.pathname === "/api/v1/scheduler/reclaim-stale") {
      const reclaimed = plane.reclaimStaleAgents();
      send(res, 200, { reclaimed });
      return;
    }

    if (method === "POST" && url.pathname === "/api/v1/scheduler/cron") {
      const created = plane.evaluateCron();
      send(res, 200, { items: created });
      return;
    }

    const resumeMatch = /^\/api\/v1\/sessions\/([^/]+)\/resume$/.exec(url.pathname);
    if (method === "POST" && resumeMatch) {
      const id = resumeMatch[1]!;
      const result = plane.resumeSession(id);
      if (!result.ok) {
        send(res, 400, {
          error: { code: "RESUME_ERROR", message: result.error },
        });
        return;
      }
      send(res, 201, result.session);
      return;
    }

    const logsMatch = /^\/api\/v1\/sessions\/([^/]+)\/logs$/.exec(url.pathname);
    if (method === "GET" && logsMatch) {
      const id = logsMatch[1]!;
      send(res, 200, { items: plane.getLogs(id) });
      return;
    }

    const archiveMatch = /^\/api\/v1\/sessions\/([^/]+)\/archive$/.exec(url.pathname);
    if (method === "POST" && archiveMatch) {
      const id = archiveMatch[1]!;
      const archived = plane.archiveSessionLogs(id);
      send(res, 200, archived);
      return;
    }

    if (method === "POST" && url.pathname === "/api/v1/agents/drain") {
      try {
        const body = (await readJson(req)) as { agentId?: string };
        if (!body.agentId) {
          send(res, 400, {
            error: { code: "VALIDATION_ERROR", message: "agentId required" },
          });
          return;
        }
        send(res, 200, plane.drainAgent(body.agentId));
        return;
      } catch {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
        });
        return;
      }
    }

    const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && sessionMatch) {
      const id = sessionMatch[1]!;
      const session = plane.getSession(id);
      if (!session) {
        send(res, 404, {
          error: { code: "NOT_FOUND", message: "session not found" },
        });
        return;
      }
      send(res, 200, session);
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
      publicBaseUrl: options.publicBaseUrl ?? "http://localhost:3000",
    });
    plane = created.plane;
    store = new MemorySessionStore({ plane });
  } else if (!plane && store) {
    plane = store.plane;
  } else if (!plane) {
    plane = new ControlPlane({
      publicBaseUrl: options.publicBaseUrl ?? "http://localhost:3000",
    });
    store = new MemorySessionStore({ plane });
  }

  // Wire WS delivery (and optional extra handler) after plane exists.
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
