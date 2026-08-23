/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

describe("createLocalApp agent and scheduler routes", () => {
  it("covers agents, scheduler, logs, resume, clone, drain routes", async () => {
    const plane = new ControlPlane({
      idFactory: (() => {
        let n = 0;
        return () => `sess-${++n}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
      publicBaseUrl: "http://ui",
      shardCount: 1,
    });
    plane.registerHost({
      hostId: "a1",
      worktrees: [{ id: "wt-1", name: "wt-1", repositoryId: "r1", path: "/w", labels: [] }],
    });
    plane.createCommand({
      id: "cmd-echo",
      name: "echo-prompt",
      argv: ["echo"],
      providerId: null,
    });
    const { handler } = createLocalApp({ plane });

    const invoke = (method: string, path: string, body?: unknown) =>
      invokeHandler(handler as never, method, path, body);

    expect((await invoke("GET", "/api/v1/hosts")).status).toBe(200);
    expect((await invoke("GET", "/api/v1/worktrees")).status).toBe(200);
    expect((await invoke("GET", "/api/v1/sessions?sort=priority_desc")).status).toBe(200);
    expect((await invoke("GET", "/api/v1/sessions?sort=priority_asc")).status).toBe(200);

    const created = await invoke("POST", "/api/v1/sessions", {
      repositoryId: "r1",
      prompt: "p",
      target: { commandId: "cmd-echo" },
      timeout: 10,
      ref: "main",
      concurrencyId: "filaments-pr-shepherd-1",
      metadata: { a: 1 },
    });
    expect(created.status).toBe(201);

    expect((await invoke("POST", "/api/v1/scheduler/assign")).status).toBe(200);
    const assigned = plane.getSession("sess-1")!;
    expect(
      (
        await invoke("POST", "/api/v1/host/messages", {
          type: "session:ack",
          sessionId: "sess-1",
          worktreeId: assigned.worktreeId as string,
          attemptId: assigned.attemptId as string,
        })
      ).status,
    ).toBe(410);
    expect(
      (
        await invoke("POST", "/api/v1/host/messages", {
          type: "session:usage",
          sessionId: "sess-1",
          worktreeId: assigned.worktreeId as string,
          attemptId: assigned.attemptId as string,
          usage: {
            kind: "delta",
            sequence: 1,
            inputTokens: "1",
            source: "cli",
            observedAt: "2026-01-01T00:00:00.000Z",
          },
        })
      ).status,
    ).toBe(410);
    expect(
      (
        await invoke("POST", "/api/v1/host/messages", {
          type: "session:log",
          sessionId: "sess-1",
          stream: "stdout",
          content: "x",
          timestamp: "2026-01-01T00:00:00.000Z",
          seq: 1,
        })
      ).status,
    ).toBe(410);
    expect(
      (
        await invoke("POST", "/api/v1/host/messages", {
          type: "session:status",
          sessionId: "sess-1",
          worktreeId: assigned.worktreeId as string,
          attemptId: assigned.attemptId as string,
          status: "completed",
        })
      ).status,
    ).toBe(410);
    // Stateful daemon frames are deliberately WebSocket-only; complete the
    // local fixture through the in-process control-plane seam instead.
    expect(
      plane.handleHostMessage({
        type: "session:ack",
        sessionId: "sess-1",
        worktreeId: assigned.worktreeId as string,
        attemptId: assigned.attemptId as string,
      }).ok,
    ).toBe(true);
    expect(
      plane.handleHostMessage({
        type: "session:log",
        sessionId: "sess-1",
        stream: "stdout",
        content: "x",
        timestamp: "2026-01-01T00:00:00.000Z",
        seq: 1,
      }).ok,
    ).toBe(true);
    expect(
      plane.handleHostMessage({
        type: "session:status",
        sessionId: "sess-1",
        worktreeId: assigned.worktreeId as string,
        attemptId: assigned.attemptId as string,
        status: "completed",
      }).ok,
    ).toBe(true);
    expect((await invoke("GET", "/api/v1/sessions/sess-1/logs")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/sessions/sess-1/archive")).status).toBe(200);
    const cloned = await invoke("POST", "/api/v1/sessions/sess-1/clone", { priority: 7 });
    expect(cloned.status).toBe(201);
    expect(cloned.json).toMatchObject({
      id: "sess-2",
      status: "queued",
      priority: 7,
      created: true,
    });
    expect(
      (await invoke("POST", "/api/v1/sessions/sess-1/clone", { commandId: "not-allowed" })).status,
    ).toBe(400);
    const resumed = await invoke("POST", "/api/v1/sessions/sess-1/resume", {
      prompt: "continue with the edge case",
      timeout: 20,
      priority: 4,
      concurrencyId: "filaments-pr-shepherd-1",
    });
    expect(resumed.status).toBe(201);
    expect(resumed.json).toMatchObject({
      prompt: "continue with the edge case",
      timeout: 20,
      priority: 4,
    });
    expect((await invoke("POST", "/api/v1/sessions/sess-1/resume", {})).status).toBe(200);
    expect(
      (
        await invoke("POST", "/api/v1/sessions/sess-1/resume", {
          concurrencyId: "different",
        })
      ).status,
    ).toBe(400);
    expect(
      (await invoke("POST", "/api/v1/sessions/sess-1/resume", { concurrencyId: 1 })).status,
    ).toBe(400);
    expect(
      (await invoke("POST", "/api/v1/sessions/sess-1/resume", { commandId: "override" })).status,
    ).toBe(400);
    expect((await invoke("POST", "/api/v1/sessions/sess-1/resume", { timeout: "20" })).status).toBe(
      400,
    );
    expect((await invoke("POST", "/api/v1/sessions/sess-1/resume", { prompt: "" })).status).toBe(
      400,
    );
    expect(
      (await invoke("POST", "/api/v1/sessions/sess-1/resume", { priority: "high" })).status,
    ).toBe(400);
    expect((await invoke("POST", "/api/v1/sessions/sess-1/resume", [])).status).toBe(400);
    expect(
      (
        await invoke(
          "GET",
          "/api/v1/sessions?limit=5&hostId=a1&status=completed&sort=oldest&repositoryId=r1&concurrencyId=k&scheduleId=nightly&source=ui",
        )
      ).status,
    ).toBe(200);
    expect((await invoke("POST", "/api/v1/scheduler/ack-deadlines")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/scheduler/reclaim-stale")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/scheduler/cron")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/hosts/drain", { hostId: "a1" })).status).toBe(200);
    plane.drainHostDurable = async () => ({ ok: false, runningSessionIds: [] });
    expect((await invoke("POST", "/api/v1/hosts/drain", { hostId: "a1" })).status).toBe(409);
    expect((await invoke("POST", "/api/v1/hosts/drain", {})).status).toBe(400);
    const concurrencyFirst = await invoke("POST", "/api/v1/sessions", {
      repositoryId: "r1",
      prompt: "p",
      target: { commandId: "cmd-echo" },
      timeout: 1,
      concurrencyId: "k",
    });
    expect(concurrencyFirst.status).toBe(201);
    const concurrencyDuplicate = await invoke("POST", "/api/v1/sessions", {
      repositoryId: "r1",
      prompt: "p2",
      target: { commandId: "cmd-echo" },
      timeout: 1,
      concurrencyId: "k",
    });
    expect(concurrencyDuplicate.status).toBe(200);
    expect(concurrencyDuplicate.json).toMatchObject({
      id: concurrencyFirst.json.id,
      created: false,
      concurrencyId: "k",
    });

    expect(
      (
        await invoke("POST", "/api/v1/host/messages", {
          type: "session:ack",
          sessionId: "missing",
          worktreeId: "missing",
          attemptId: "missing",
        })
      ).status,
    ).toBe(410);
    expect((await invoke("POST", "/api/v1/sessions/nope/resume")).status).toBe(404);

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
        setHeader() {
          /* cors */
        },
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
    expect(await badJson("/api/v1/host/messages")).toBe(400);
    expect(await badJson("/api/v1/hosts/drain")).toBe(400);
    expect(await badJson("/api/v1/sessions/sess-1/resume")).toBe(400);

    plane.createSessionDurable = async () => ({
      ok: false,
      error: "session id collision",
      code: "CONFLICT",
    });
    expect(
      (
        await invoke("POST", "/api/v1/sessions", {
          repositoryId: "r1",
          prompt: "collision",
          target: { commandId: "cmd-echo" },
          timeout: 1,
        })
      ).status,
    ).toBe(409);
  });

  it("filters GET /worktrees by ?hostId= instead of forcing every caller to fetch the whole fleet", async () => {
    const plane = new ControlPlane({
      idFactory: (() => {
        let n = 0;
        return () => `sess-${++n}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
      publicBaseUrl: "http://ui",
      shardCount: 1,
    });
    plane.registerHost({
      hostId: "host-a",
      worktrees: [{ id: "wt-a", name: "wt-a", repositoryId: "r1", path: "/a", labels: [] }],
    });
    plane.registerHost({
      hostId: "host-b",
      worktrees: [{ id: "wt-b", name: "wt-b", repositoryId: "r1", path: "/b", labels: [] }],
    });
    const { handler } = createLocalApp({ plane });
    const invoke = (path: string) => invokeHandler(handler as never, "GET", path);

    const scoped = await invoke("/api/v1/worktrees?hostId=host-a");
    expect(scoped.status).toBe(200);
    expect(scoped.json).toMatchObject({ items: [expect.objectContaining({ id: "wt-a" })] });

    const unscoped = await invoke("/api/v1/worktrees");
    expect((unscoped.json as { items: unknown[] }).items).toHaveLength(2);

    const none = await invoke("/api/v1/worktrees?hostId=host-missing");
    expect((none.json as { items: unknown[] }).items).toHaveLength(0);
  });
});
