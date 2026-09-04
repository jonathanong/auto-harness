import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";
import {
  finishedLoggedSessionPlane,
  minimalSession,
} from "./control-plane-prior-context-test-helpers.ts";

describe("GET /sessions/:id/prior-context", () => {
  it("returns the rendered transcript of the resumed-from session", async () => {
    const plane = finishedLoggedSessionPlane("did the thing");
    // A running session's hostId is set at assign time; a fallback resume records
    // resumedFromSessionId without a native pin. Set both directly to exercise the
    // route without needing the full resume + fallback-routing pipeline here.
    plane.state.sessions.set("s2", {
      ...plane.state.sessions.get("s1")!,
      id: "s2",
      status: "running",
      hostId: "host-2",
      worktreeId: "wt-2",
      resumedFromSessionId: "s1",
    });

    const { handler } = createLocalApp({ plane });
    const response = await invokeHandler(handler, "GET", "/api/v1/sessions/s2/prior-context");
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ sourceSessionId: "s1", truncated: false });
    expect((response.json as { content: string }).content).toContain("did the thing");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("404s when the session has no resumedFromSessionId", async () => {
    const plane = new ControlPlane({ shardCount: 1 });
    plane.createCommand({ id: "cmd", name: "echo", argv: ["echo"], providerId: null });
    plane.createSession({
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: "cmd" },
      timeout: 30,
    });
    const session = plane.listSessions()[0]!;
    const { handler } = createLocalApp({ plane });
    const response = await invokeHandler(
      handler,
      "GET",
      `/api/v1/sessions/${session.id}/prior-context`,
    );
    expect(response.status).toBe(404);
    expect(response.json).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("404s when the resumed-from session has no transcript", async () => {
    const plane = new ControlPlane({ shardCount: 1 });
    plane.createCommand({ id: "cmd", name: "echo", argv: ["echo"], providerId: null });
    plane.state.sessions.set("empty-source", minimalSession({ id: "empty-source" }));
    plane.state.sessions.set(
      "s2",
      minimalSession({
        id: "s2",
        status: "running",
        hostId: "host-2",
        resumedFromSessionId: "empty-source",
      }),
    );
    const { handler } = createLocalApp({ plane });
    const response = await invokeHandler(handler, "GET", "/api/v1/sessions/s2/prior-context");
    expect(response.status).toBe(404);
    expect(response.json).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("404s for an unknown session id", async () => {
    const plane = new ControlPlane({ shardCount: 1 });
    const { handler } = createLocalApp({ plane });
    const response = await invokeHandler(handler, "GET", "/api/v1/sessions/missing/prior-context");
    expect(response.status).toBe(404);
  });

  it("returns a 500 instead of throwing when the durable read fails", async () => {
    const plane = new ControlPlane({ shardCount: 1 });
    plane.state.storage = {
      getSession: async () => {
        throw new Error("dynamo unavailable");
      },
    } as never;
    const { handler } = createLocalApp({ plane });
    const response = await invokeHandler(handler, "GET", "/api/v1/sessions/s2/prior-context");
    expect(response.status).toBe(500);
  });
});
