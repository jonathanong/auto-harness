import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

describe("createLocalApp agent and scheduler routes", () => {
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
    plane.registerHost({
      hostId: "a1",
      worktrees: [{ id: "wt-1", name: "wt-1", repositoryId: "r1", path: "/w", labels: [] }],
      commandProfiles: ["echo-prompt"],
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
    expect((await invoke("GET", "/api/v1/command-profiles")).status).toBe(200);
    expect((await invoke("GET", "/api/v1/worktrees")).status).toBe(200);

    const created = await invoke("POST", "/api/v1/sessions", {
      repositoryId: "r1",
      prompt: "p",
      target: { commandId: "cmd-echo" },
      timeout: 10,
      ref: "main",
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
    expect(plane.handleHostMessage({ type: "session:ack", sessionId: "sess-1" }).ok).toBe(true);
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
      plane.handleHostMessage({ type: "session:status", sessionId: "sess-1", status: "completed" })
        .ok,
    ).toBe(true);
    expect((await invoke("GET", "/api/v1/sessions/sess-1/logs")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/sessions/sess-1/archive")).status).toBe(200);
    const resumed = await invoke("POST", "/api/v1/sessions/sess-1/resume", {
      prompt: "continue with the edge case",
      timeout: 20,
      priority: 4,
    });
    expect(resumed.status).toBe(201);
    expect(resumed.json).toMatchObject({
      prompt: "continue with the edge case",
      timeout: 20,
      priority: 4,
    });
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
      (await invoke("GET", "/api/v1/sessions?limit=5&cursor=&hostId=a1&status=completed&q=p"))
        .status,
    ).toBe(200);
    expect((await invoke("POST", "/api/v1/scheduler/ack-deadlines")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/scheduler/reclaim-stale")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/scheduler/cron")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/hosts/drain", { hostId: "a1" })).status).toBe(200);
    plane.drainHostDurable = async () => ({ ok: false, runningSessionIds: [] });
    expect((await invoke("POST", "/api/v1/hosts/drain", { hostId: "a1" })).status).toBe(409);
    expect((await invoke("POST", "/api/v1/hosts/drain", {})).status).toBe(400);
    expect(
      (
        await invoke("POST", "/api/v1/sessions", {
          repositoryId: "r1",
          prompt: "p",
          target: { commandId: "cmd-echo" },
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
          target: { commandId: "cmd-echo" },
          timeout: 1,
          concurrencyKey: "k",
          onConflict: "reject",
        })
      ).status,
    ).toBe(409);

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
  });
});
