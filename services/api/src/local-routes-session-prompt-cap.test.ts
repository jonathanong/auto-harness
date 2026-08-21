import { describe, expect, it } from "vitest";
import { MAX_PROMPT_BYTES, promptByteLengthError } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

const atCap = "x".repeat(MAX_PROMPT_BYTES);
const overCap = "x".repeat(MAX_PROMPT_BYTES + 1);
const overCapError = {
  error: { code: "VALIDATION_ERROR", message: promptByteLengthError(overCap) },
};

function finish(plane: ControlPlane, sessionId: string): void {
  const session = plane.getSession(sessionId)!;
  plane.handleHostMessage({
    type: "session:ack",
    sessionId,
    worktreeId: session.worktreeId!,
    attemptId: session.attemptId!,
  });
  plane.handleHostMessage({
    type: "session:status",
    sessionId,
    worktreeId: session.worktreeId!,
    attemptId: session.attemptId!,
    status: "completed",
  });
}

describe("session prompt byte cap on create and resume", () => {
  it("accepts 65536 UTF-8 bytes and rejects 65537 on both endpoints", async () => {
    const plane = new ControlPlane({
      idFactory: (() => {
        let n = 0;
        return () => `session-${++n}`;
      })(),
    });
    seedBaseCommand(plane);
    const { handler } = createLocalApp({ plane });
    const post = (path: string, body: unknown) => invokeHandler(handler, "POST", path, body);

    const createdAtCap = await post("/api/v1/sessions", baseSessionBody({ prompt: atCap }));
    expect(createdAtCap.status).toBe(201);
    expect((createdAtCap.json as { prompt: string }).prompt).toHaveLength(MAX_PROMPT_BYTES);

    const createdOver = await post("/api/v1/sessions", baseSessionBody({ prompt: overCap }));
    expect(createdOver.status).toBe(400);
    expect(createdOver.json).toEqual(overCapError);

    plane.registerHost({
      hostId: "host",
      worktrees: [{ id: "wt", name: "wt", repositoryId: "repo-1", path: "/wt", labels: [] }],
      commandProfiles: [],
    });
    plane.assignQueued();
    finish(plane, (createdAtCap.json as { id: string }).id);
    const source = plane.createSession(baseSessionBody({ prompt: "source" }));
    expect(source.ok).toBe(true);
    if (!source.ok) throw new Error(source.error);
    plane.assignQueued();
    finish(plane, source.session.id);

    const resumedAtCap = await post(`/api/v1/sessions/${source.session.id}/resume`, {
      prompt: atCap,
    });
    expect(resumedAtCap.status).toBe(201);
    expect((resumedAtCap.json as { prompt: string }).prompt).toHaveLength(MAX_PROMPT_BYTES);

    const resumedOver = await post(`/api/v1/sessions/${source.session.id}/resume`, {
      prompt: overCap,
    });
    expect(resumedOver.status).toBe(400);
    expect(resumedOver.json).toEqual(overCapError);
    expect(overCapError.error.message).toBe("prompt must be at most 65536 bytes");
  });
});
