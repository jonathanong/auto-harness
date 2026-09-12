import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

describe("POST /api/v1/sessions/:id/archive active-session fence", () => {
  it("rejects an active session before taking an archive snapshot", async () => {
    const plane = new ControlPlane({ idFactory: () => "active-session" });
    plane.createRepository({
      id: "repository",
      name: "repository",
      url: "https://example.test/repository.git",
    });
    plane.createCommand({
      id: "command",
      name: "echo",
      argv: ["echo"],
      providerId: null,
    });
    const created = plane.createSession({
      repositoryId: "repository",
      prompt: "work",
      target: { commandId: "command" },
      timeout: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    plane.state.sessions.set(created.session.id, { ...created.session, status: "running" });
    plane.state.logs.set(created.session.id, [
      {
        sessionId: created.session.id,
        timestampSeq: "2026-01-01T00:00:00.000Z#0000000000",
        timestamp: "2026-01-01T00:00:00.000Z",
        seq: 0,
        stream: "stdout",
        content: "active-output",
      },
    ]);
    const { handler } = createLocalApp({ plane });

    const response = await invokeHandler(
      handler,
      "POST",
      `/api/v1/sessions/${created.session.id}/archive`,
    );

    expect(response.status).toBe(409);
    expect(response.json).toEqual({
      error: { code: "CONFLICT", message: "session must be terminal before archiving" },
    });
    expect(plane.getArchive(created.session.id)).toBeNull();
  });
});
