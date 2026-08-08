import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";

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
        setHeader() {
          /* cors */
        },
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
      commandId: "cmd-echo",
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
    expect(
      (await invoke("GET", "/api/v1/sessions?limit=5&cursor=&hostId=a1&status=completed&q=p"))
        .status,
    ).toBe(200);
    expect((await invoke("POST", "/api/v1/scheduler/ack-deadlines")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/scheduler/reclaim-stale")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/scheduler/cron")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/agents/drain", { hostId: "a1" })).status).toBe(200);
    expect((await invoke("POST", "/api/v1/agents/drain", {})).status).toBe(400);
    expect(
      (
        await invoke("POST", "/api/v1/sessions", {
          repositoryId: "r1",
          prompt: "p",
          commandId: "cmd-echo",
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
          commandId: "cmd-echo",
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
    expect(await badJson("/api/v1/agent/messages")).toBe(400);
    expect(await badJson("/api/v1/agents/drain")).toBe(400);
  });
});
