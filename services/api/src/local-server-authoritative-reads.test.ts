import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createAuthoritativeReadStorage } from "./control-plane-authoritative-read-test-helpers.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

describe("durable session routes", () => {
  it("reads ordered log history written by a different control plane", async () => {
    const storage = createAuthoritativeReadStorage();
    const writer = new ControlPlane({
      storage,
      commandIdFactory: () => "command",
      idFactory: () => "session",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect((await writer.createCommandDurable({ name: "command", argv: ["echo"] })).ok).toBe(true);
    expect(
      (
        await writer.createSessionDurable({
          repositoryId: "repository",
          prompt: "work",
          target: { commandId: "command" },
          timeout: 1,
        })
      ).ok,
    ).toBe(true);
    for (const [seq, stream, content] of [
      [2, "stdout", "command output"],
      [1, "system", "Session started at 2026-01-01T00:00:00.000Z"],
    ] as const) {
      await writer.handleHostMessageDurable({
        type: "session:log",
        sessionId: "session",
        attemptId: "a",
        stream,
        content,
        timestamp: "2026-01-01T00:00:00.000Z",
        seq,
      });
    }

    const { handler } = createLocalApp({ plane: new ControlPlane({ storage }) });
    const response = await invokeHandler(handler, "GET", "/api/v1/sessions/session/logs");
    expect(response.status).toBe(200);
    expect(
      (response.json as { items: Array<{ stream: string; content: string }> }).items.map(
        ({ stream, content }) => ({ stream, content }),
      ),
    ).toEqual([
      { stream: "system", content: "Session started at 2026-01-01T00:00:00.000Z" },
      { stream: "stdout", content: "command output" },
    ]);
  });

  it("enforces the bounded historical-log route contract", async () => {
    const plane = new ControlPlane();
    plane.state.sessions.set("session", {
      id: "session",
      repositoryId: "repository",
      prompt: "work",
      target: { commandId: "command" },
      fallbacks: [],
      targetLabels: ["command"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2026-01-01T00:01:00.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      status: "queued",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      type: "prompt",
      source: "api",
    });
    plane.state.logs.set("session", [
      {
        sessionId: "session",
        timestampSeq: "2026-01-01T00:00:01.000Z#0000000001",
        stream: "stdout",
        content: "later stdout",
        timestamp: "2026-01-01T00:00:01.000Z",
        seq: 1,
      },
      {
        sessionId: "session",
        timestampSeq: "2026-01-01T00:00:00.000Z#0000000002",
        stream: "stderr",
        content: "stderr",
        timestamp: "2026-01-01T00:00:00.000Z",
        seq: 2,
      },
      {
        sessionId: "session",
        timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
        stream: "stdout",
        content: "first stdout",
        timestamp: "2026-01-01T00:00:00.000Z",
        seq: 1,
      },
    ]);
    const { handler } = createLocalApp({ plane });

    const filtered = await invokeHandler(
      handler,
      "GET",
      "/api/v1/sessions/session/logs?stream=stdout&limit=1",
    );
    expect(filtered.status).toBe(200);
    expect((filtered.json as { items: Array<{ content: string }> }).items).toEqual([
      expect.objectContaining({ content: "first stdout" }),
    ]);

    const since = await invokeHandler(
      handler,
      "GET",
      "/api/v1/sessions/session/logs?since=2026-01-01T00%3A00%3A00Z",
    );
    expect(
      (since.json as { items: Array<{ content: string }> }).items.map(({ content }) => content),
    ).toEqual(["later stdout"]);

    for (const path of [
      "/api/v1/sessions/session/logs?stream=unknown",
      "/api/v1/sessions/session/logs?since=tomorrow",
      "/api/v1/sessions/session/logs?limit=10001",
    ]) {
      const response = await invokeHandler(handler, "GET", path);
      expect(response.status).toBe(400);
      expect(response.json).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    }
    const missing = await invokeHandler(handler, "GET", "/api/v1/sessions/missing/logs");
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("returns structured errors when the durable session collection or detail read fails", async () => {
    const plane = new ControlPlane({
      storage: {
        getSession: async () => {
          throw new Error("storage unavailable");
        },
        listAllSessions: async () => {
          throw new Error("storage unavailable");
        },
      } as never,
    });
    const { handler } = createLocalApp({ plane });

    for (const path of ["/api/v1/sessions", "/api/v1/sessions/session"]) {
      const response = await invokeHandler(handler, "GET", path);
      expect(response.status).toBe(500);
      expect((response.json as { error: { code: string } }).error.code).toBe("INTERNAL_ERROR");
    }
  });

  it("returns a structured 500 when durable session-log history cannot be read", async () => {
    let plane: ControlPlane;
    const storage = {
      getSession: async (id: string) => {
        const session = plane.state.sessions.get(id);
        return session ? { ...session } : null;
      },
      queryLogs: async () => {
        throw new Error("storage unavailable");
      },
    } as never;
    plane = new ControlPlane({ storage });
    plane.state.sessions.set("session", {
      id: "session",
      repositoryId: "repository",
      prompt: "work",
      target: { commandId: "command" },
      fallbacks: [],
      targetLabels: ["command"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2026-01-01T00:01:00.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      status: "queued",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      type: "prompt",
      source: "api",
    });

    const { handler } = createLocalApp({ plane });
    const response = await invokeHandler(handler, "GET", "/api/v1/sessions/session/logs");
    expect(response.status).toBe(500);
    expect((response.json as { error: { code: string } }).error.code).toBe("INTERNAL_ERROR");
  });
});
