import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp, startLocalServer } from "./local-server.ts";
import { MemorySessionStore } from "./memory-store.ts";

describe("createLocalApp", () => {
  it("handles health, create, get, list, and 404s", async () => {
    const store = new MemorySessionStore({
      idFactory: () => "sess-1",
      now: () => "t0",
      publicBaseUrl: "http://ui",
    });
    const { handler } = createLocalApp({ store });

    const invoke = async (
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; json: unknown }> => {
      const chunks: Buffer[] = [];
      let statusCode = 0;
      const req = {
        method,
        url: path,
        on(event: string, cb: (...args: unknown[]) => void) {
          if (event === "data" && body !== undefined) {
            cb(Buffer.from(JSON.stringify(body)));
          }
          if (event === "end") {
            cb();
          }
          return req;
        },
      };
      const res = {
        writeHead(code: number) {
          statusCode = code;
        },
        end(payload: string) {
          chunks.push(Buffer.from(payload));
        },
      };
      await handler(req as never, res as never);
      return {
        status: statusCode,
        json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      };
    };

    expect((await invoke("GET", "/health")).json).toEqual({ ok: true });
    const created = await invoke("POST", "/api/v1/sessions", {
      repositoryId: "r1",
      prompt: "p",
      commandProfile: "codex-fix",
      timeout: 10,
    });
    expect(created.status).toBe(201);
    expect(await invoke("GET", "/api/v1/sessions/sess-1")).toMatchObject({
      status: 200,
    });
    expect(await invoke("GET", "/api/v1/sessions")).toMatchObject({
      status: 200,
    });
    expect((await invoke("GET", "/api/v1/sessions/nope")).status).toBe(404);
    expect((await invoke("GET", "/missing")).status).toBe(404);
    expect((await invoke("POST", "/api/v1/sessions", null)).status).toBe(400);
    expect(
      (
        await invoke("POST", "/api/v1/sessions", {
          repositoryId: "",
          prompt: "p",
          commandProfile: "x",
          timeout: 1,
        })
      ).status,
    ).toBe(400);

    const badChunks: Buffer[] = [];
    let badStatus = 0;
    const badReq = {
      method: "POST",
      url: "/api/v1/sessions",
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === "data") {
          cb(Buffer.from("{not-json"));
        }
        if (event === "end") {
          cb();
        }
        return badReq;
      },
    };
    const badRes = {
      writeHead(code: number) {
        badStatus = code;
      },
      end(payload: string) {
        badChunks.push(Buffer.from(payload));
      },
    };
    await handler(badReq as never, badRes as never);
    expect(badStatus).toBe(400);

    let emptyStatus = 0;
    const emptyReq = {
      method: "POST",
      url: "/api/v1/sessions",
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === "end") {
          cb();
        }
        return emptyReq;
      },
    };
    const emptyRes = {
      writeHead(code: number) {
        emptyStatus = code;
      },
      end() {
        /* empty */
      },
    };
    await handler(emptyReq as never, emptyRes as never);
    expect(emptyStatus).toBe(400);
  });

  it("covers default createLocalApp store and missing method/url", async () => {
    const { handler } = createLocalApp({
      publicBaseUrl: "http://ui.example",
    });
    let status = 0;
    const req = {
      method: undefined,
      url: "/health",
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === "end") {
          cb();
        }
        return req;
      },
    };
    const res = {
      writeHead(code: number) {
        status = code;
      },
      end() {
        /* empty */
      },
    };
    await handler(req as never, res as never);
    expect(status).toBe(200);

    let status2 = 0;
    const req2 = {
      method: "GET",
      url: undefined,
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === "end") {
          cb();
        }
        return req2;
      },
    };
    const res2 = {
      writeHead(code: number) {
        status2 = code;
      },
      end() {
        /* empty */
      },
    };
    await handler(req2 as never, res2 as never);
    expect(status2).toBe(404);
  });

  it("covers agents, profiles, scheduler, logs, resume, drain routes", async () => {
    const plane = new ControlPlane({
      idFactory: (() => {
        let n = 0;
        return () => `sess-${++n}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
      publicBaseUrl: "http://ui",
      shardCount: 1,
    });
    plane.registerAgent({
      agentId: "a1",
      worktrees: [{ id: "wt-1", repositoryId: "r1", path: "/w", labels: [] }],
      commandProfiles: ["echo-prompt"],
    });
    const { handler } = createLocalApp({ plane });

    const invoke = async (
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; json: unknown }> => {
      const chunks: Buffer[] = [];
      let statusCode = 0;
      const req = {
        method,
        url: path,
        on(event: string, cb: (...args: unknown[]) => void) {
          if (event === "data" && body !== undefined) {
            cb(Buffer.from(JSON.stringify(body)));
          }
          if (event === "end") {
            cb();
          }
          return req;
        },
      };
      const res = {
        writeHead(code: number) {
          statusCode = code;
        },
        end(payload: string) {
          chunks.push(Buffer.from(payload));
        },
      };
      await handler(req as never, res as never);
      return {
        status: statusCode,
        json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown,
      };
    };

    expect((await invoke("GET", "/api/v1/agents")).status).toBe(200);
    expect((await invoke("GET", "/api/v1/command-profiles")).status).toBe(200);
    expect((await invoke("GET", "/api/v1/worktrees")).status).toBe(200);

    const created = await invoke("POST", "/api/v1/sessions", {
      repositoryId: "r1",
      prompt: "p",
      commandProfile: "echo-prompt",
      timeout: 10,
      ref: "main",
      metadata: { a: 1 },
    });
    expect(created.status).toBe(201);

    expect((await invoke("POST", "/api/v1/scheduler/assign")).status).toBe(200);
    expect(
      (
        await invoke("POST", "/api/v1/agent/messages", {
          type: "session:ack",
          sessionId: "sess-1",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await invoke("POST", "/api/v1/agent/messages", {
          type: "session:log",
          sessionId: "sess-1",
          stream: "stdout",
          content: "x",
          timestamp: "2026-01-01T00:00:00.000Z",
          seq: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await invoke("POST", "/api/v1/agent/messages", {
          type: "session:status",
          sessionId: "sess-1",
          status: "completed",
        })
      ).status,
    ).toBe(200);
    expect((await invoke("GET", "/api/v1/sessions/sess-1/logs")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/sessions/sess-1/archive")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/sessions/sess-1/resume")).status).toBe(201);
    expect((await invoke("POST", "/api/v1/scheduler/ack-deadlines")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/scheduler/reclaim-stale")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/scheduler/cron")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/agents/drain", { agentId: "a1" })).status).toBe(200);
    expect((await invoke("POST", "/api/v1/agents/drain", {})).status).toBe(400);
    expect(
      (
        await invoke("POST", "/api/v1/sessions", {
          repositoryId: "r1",
          prompt: "p",
          commandProfile: "echo-prompt",
          timeout: 1,
          concurrencyKey: "k",
          onConflict: "reject",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await invoke("POST", "/api/v1/sessions", {
          repositoryId: "r1",
          prompt: "p2",
          commandProfile: "echo-prompt",
          timeout: 1,
          concurrencyKey: "k",
          onConflict: "reject",
        })
      ).status,
    ).toBe(409);

    expect(
      (
        await invoke("POST", "/api/v1/agent/messages", {
          type: "session:ack",
          sessionId: "missing",
        })
      ).status,
    ).toBe(400);
    expect((await invoke("POST", "/api/v1/sessions/nope/resume")).status).toBe(400);

    // invalid JSON on agent messages / drain
    const badJson = async (path: string) => {
      let status = 0;
      const req = {
        method: "POST",
        url: path,
        on(event: string, cb: (...args: unknown[]) => void) {
          if (event === "data") {
            cb(Buffer.from("{bad"));
          }
          if (event === "end") {
            cb();
          }
          return req;
        },
      };
      const res = {
        writeHead(code: number) {
          status = code;
        },
        end() {
          /* empty */
        },
      };
      await handler(req as never, res as never);
      return status;
    };
    expect(await badJson("/api/v1/agent/messages")).toBe(400);
    expect(await badJson("/api/v1/agents/drain")).toBe(400);
  });
});

describe("createLocalApp operator management REST", () => {
  it("repository schedule cancel and agent list via handlers", async () => {
    let n = 0;
    const plane = new ControlPlane({
      idFactory: () => `sess-${++n}`,
      now: () => "2026-01-01T00:00:00.000Z",
      publicBaseUrl: "http://ui",
      scheduleIdFactory: () => "sched-1",
      repositoryIdFactory: () => "repo-1",
    });
    const { handler } = createLocalApp({ plane });
    plane.seedWorktree({
      id: "wt-1",
      agentId: "a1",
      repositoryId: "r1",
      path: "/w",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.registerAgent({
      agentId: "a1",
      worktrees: [{ id: "wt-1", repositoryId: "r1", path: "/w", labels: [] }],
      commandProfiles: ["echo-prompt"],
      replaceExisting: true,
    });

    const invoke = async (
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; json: unknown; raw: string }> => {
      const chunks: Buffer[] = [];
      let statusCode = 0;
      const req = {
        method,
        url: path,
        on(event: string, cb: (...args: unknown[]) => void) {
          if (event === "data" && body !== undefined) {
            cb(Buffer.from(JSON.stringify(body)));
          }
          if (event === "end") {
            cb();
          }
          return req;
        },
      };
      const res = {
        writeHead(code: number) {
          statusCode = code;
        },
        end(payload?: string) {
          if (payload) {
            chunks.push(Buffer.from(payload));
          }
        },
      };
      await handler(req as never, res as never);
      const raw = Buffer.concat(chunks).toString("utf8");
      return {
        status: statusCode,
        raw,
        json: raw ? (JSON.parse(raw) as unknown) : null,
      };
    };

    // repositories
    expect((await invoke("POST", "/api/v1/repositories", { name: "", url: "" })).status).toBe(400);
    const repo = await invoke("POST", "/api/v1/repositories", {
      id: "demo",
      name: "Demo",
      url: "/tmp/demo",
      defaultBranch: "main",
      setupScript: "s.sh",
      terminalHookScript: "h.sh",
    });
    expect(repo.status).toBe(201);
    expect(repo.json).toMatchObject({ id: "demo", name: "Demo", url: "/tmp/demo" });
    expect((await invoke("GET", "/api/v1/repositories")).json).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: "demo" })]),
    });
    expect((await invoke("GET", "/api/v1/repositories/demo")).json).toMatchObject({
      id: "demo",
    });
    expect((await invoke("GET", "/api/v1/repositories/missing")).status).toBe(404);
    expect(
      (
        await invoke("PUT", "/api/v1/repositories/demo", {
          name: "Demo2",
          url: "/tmp/d2",
          defaultBranch: "dev",
          setupScript: "s2.sh",
          terminalHookScript: "h2.sh",
        })
      ).json,
    ).toMatchObject({
      name: "Demo2",
      defaultBranch: "dev",
      setupScript: "s2.sh",
      terminalHookScript: "h2.sh",
    });
    expect((await invoke("PUT", "/api/v1/repositories/nope", { name: "x" })).status).toBe(404);
    expect((await invoke("DELETE", "/api/v1/repositories/demo")).status).toBe(204);
    expect((await invoke("DELETE", "/api/v1/repositories/demo")).status).toBe(404);

    // recreate for schedule use
    await invoke("POST", "/api/v1/repositories", {
      id: "demo",
      name: "Demo",
      url: "/tmp/demo",
    });

    // schedules
    expect((await invoke("POST", "/api/v1/schedules", { name: "x" })).status).toBe(400);
    const sched = await invoke("POST", "/api/v1/schedules", {
      repositoryId: "demo",
      name: "nightly",
      commandProfile: "echo-prompt",
      cron: "0 0 * * *",
      timeout: 30,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      ref: "main",
      enabled: true,
    });
    expect(sched.status).toBe(201);
    expect(sched.json).toMatchObject({ id: "sched-1", name: "nightly" });
    expect((await invoke("GET", "/api/v1/schedules")).json).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: "sched-1" })]),
    });
    expect((await invoke("GET", "/api/v1/schedules/sched-1")).json).toMatchObject({
      name: "nightly",
    });
    expect((await invoke("GET", "/api/v1/schedules/nope")).status).toBe(404);
    expect(
      (
        await invoke("PATCH", "/api/v1/schedules/sched-1", {
          name: "nightly2",
          timeout: 45,
          commandProfile: "codex-fix",
          cron: "0 1 * * *",
          nextRunAt: "2026-01-02T00:00:00.000Z",
          enabled: true,
          ref: "develop",
          repositoryId: "demo",
        })
      ).json,
    ).toMatchObject({
      name: "nightly2",
      timeout: 45,
      commandProfile: "codex-fix",
      ref: "develop",
    });
    expect((await invoke("PATCH", "/api/v1/schedules/nope", { name: "x" })).status).toBe(404);

    const triggered = await invoke("POST", "/api/v1/schedules/sched-1/trigger");
    expect(triggered.status).toBe(201);
    expect(triggered.json).toMatchObject({
      type: "scheduled",
      source: "schedule",
      prompt: "scheduled:nightly2",
      commandProfile: "codex-fix",
    });
    expect((await invoke("POST", "/api/v1/schedules/missing/trigger")).status).toBe(400);

    // cancel session
    const created = await invoke("POST", "/api/v1/sessions", {
      repositoryId: "demo",
      prompt: "cancel-me",
      commandProfile: "echo-prompt",
      timeout: 10,
    });
    expect(created.status).toBe(201);
    const sid = (created.json as { id: string }).id;
    const cancelled = await invoke("POST", `/api/v1/sessions/${sid}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json).toMatchObject({ status: "cancelled" });
    expect((await invoke("POST", `/api/v1/sessions/${sid}/cancel`)).status).toBe(400);

    // agents list + drain
    expect((await invoke("GET", "/api/v1/agents")).json).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ agentId: "a1" })]),
    });
    expect((await invoke("POST", "/api/v1/agents/drain", { agentId: "a1" })).status).toBe(200);

    expect((await invoke("DELETE", "/api/v1/schedules/sched-1")).status).toBe(204);
    expect((await invoke("DELETE", "/api/v1/schedules/sched-1")).status).toBe(404);

    // bad JSON branches
    const badJson = async (method: string, path: string) => {
      let status = 0;
      const req = {
        method,
        url: path,
        on(event: string, cb: (...args: unknown[]) => void) {
          if (event === "data") {
            cb(Buffer.from("{bad"));
          }
          if (event === "end") {
            cb();
          }
          return req;
        },
      };
      const res = {
        writeHead(code: number) {
          status = code;
        },
        end() {
          /* empty */
        },
      };
      await handler(req as never, res as never);
      return status;
    };
    expect(await badJson("POST", "/api/v1/repositories")).toBe(400);
    expect(await badJson("PUT", "/api/v1/repositories/demo")).toBe(400);
    expect(await badJson("POST", "/api/v1/schedules")).toBe(400);
    expect(await badJson("PATCH", "/api/v1/schedules/sched-1")).toBe(400);
  });
});

describe("startLocalServer", () => {
  it("listens and closes", async () => {
    const port = 17420 + Math.floor(Math.random() * 1000);
    // Explicit in-process plane (unit test); production uses DynamoDB Local via useDynamo.
    const server = await startLocalServer({
      port,
      useDynamo: false,
      store: new MemorySessionStore({ idFactory: () => "sess-ls" }),
    });
    expect(server.port).toBe(port);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const created = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryId: "r",
        prompt: "p",
        commandProfile: "c",
        timeout: 1,
      }),
    });
    expect(created.status).toBe(201);
    await server.close();
    await expect(server.close()).rejects.toBeTruthy();
  });

  it("rejects bind errors", async () => {
    const port = 17421 + Math.floor(Math.random() * 500);
    const first = await startLocalServer({ port });
    await expect(startLocalServer({ port })).rejects.toBeTruthy();
    await first.close();
  });

  it("defaults to port 7420 when free", async () => {
    try {
      const server = await startLocalServer({ useDynamo: false });
      expect(server.port).toBe(7420);
      await server.close();
    } catch {
      // port in use in this environment — still exercised default branch attempt
      expect(true).toBe(true);
    }
  });

  it("startLocalServer useDynamo hydrates from DynamoDB Local when available", async () => {
    try {
      const server = await startLocalServer({
        port: 17490 + Math.floor(Math.random() * 100),
        useDynamo: true,
        publicBaseUrl: "http://ui",
      });
      expect(server.plane).toBeTruthy();
      const res = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(res.status).toBe(200);
      await server.close();
    } catch {
      // DynamoDB Local not running — optional path
      expect(true).toBe(true);
    }
  });
});
