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
    for (const [seq, content] of [
      [2, "second"],
      [1, "first"],
    ] as const) {
      await writer.handleHostMessageDurable({
        type: "session:log",
        sessionId: "session",
        stream: "stdout",
        content,
        timestamp: "2026-01-01T00:00:00.000Z",
        seq,
      });
    }

    const { handler } = createLocalApp({ plane: new ControlPlane({ storage }) });
    const response = await invokeHandler(handler, "GET", "/api/v1/sessions/session/logs");
    expect(response.status).toBe(200);
    expect(
      (response.json as { items: Array<{ content: string }> }).items.map(({ content }) => content),
    ).toEqual(["first", "second"]);
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
      listLogs: async () => {
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
