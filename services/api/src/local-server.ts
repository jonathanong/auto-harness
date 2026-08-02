import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { AgentToServerMessage } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.js";
import { MemorySessionStore } from "./memory-store.js";

type LocalServerOptions = {
  port?: number;
  store?: MemorySessionStore;
  plane?: ControlPlane;
  publicBaseUrl?: string;
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
}> {
  const port = options.port ?? 7420;
  const { store, plane, handler } = createLocalApp(options);
  const server = createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, () => {
      resolve();
    });
    server.on("error", reject);
  });

  return {
    port,
    store,
    plane,
    close: () =>
      new Promise((resolve, reject) => {
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
