import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

describe("usage report authorization", () => {
  it("requires auth, a repository scope, and permits an authorized read-only scope", async () => {
    const auth = new AuthService({
      mode: "required",
      secret: "s".repeat(32),
      admins: Buffer.from(JSON.stringify([{ username: "admin", password: "password" }])).toString(
        "base64url",
      ),
    });
    const { apiKey } = await auth.createServiceAccount({
      name: "reader",
      role: "read-only",
      allowedRepositoryIds: ["repo-1"],
    });
    const { handler } = createLocalApp({ plane: new ControlPlane(), authService: auth });

    expect((await invokeHandler(handler, "GET", "/api/v1/usage?repositoryId=repo-1")).status).toBe(
      401,
    );
    const headers = { authorization: `Bearer ${apiKey}` };
    expect((await invokeHandler(handler, "GET", "/api/v1/usage", undefined, headers)).status).toBe(
      400,
    );
    const response = await invokeHandler(
      handler,
      "GET",
      "/api/v1/usage?repositoryId=repo-1",
      undefined,
      headers,
    );
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ aggregate: { costMicros: "0" }, items: [] });
    expect(
      (await invokeHandler(handler, "GET", "/api/v1/usage?repositoryId=repo-2", undefined, headers))
        .status,
    ).toBe(404);
  });

  it("returns session and repository usage scoped by durable route attribution", async () => {
    const plane = new ControlPlane();
    plane.state.sessions.set("session-1", {
      id: "session-1",
      repositoryId: "repo-1",
      attemptId: "attempt-1",
      worktreeId: "worktree-1",
    } as never);
    plane.state.usageRecords.set("record-1", {
      sessionId: "session-1",
      repositoryId: "repo-1",
      providerId: "provider-1",
      providerAccountId: "account-1",
      commandId: "command-1",
      attemptId: "attempt-1",
      worktreeId: "worktree-1",
      kind: "delta",
      sequence: 1,
      inputTokens: "3",
      costMicros: "6",
      currency: "USD",
      source: "cli",
      observedAt: "2026-01-01T00:00:00.000Z",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });
    plane.state.usageRecords.set("record-2", {
      sessionId: "session-2",
      repositoryId: "repo-1",
      providerId: "provider-2",
      attemptId: "attempt-2",
      worktreeId: "worktree-2",
      kind: "delta",
      sequence: 1,
      inputTokens: "7",
      source: "cli",
      observedAt: "2026-01-01T00:00:00.000Z",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });
    const { handler } = createLocalApp({ plane });

    const session = await invokeHandler(handler, "GET", "/api/v1/sessions/session-1/usage");
    expect(session.status).toBe(200);
    expect(session.json).toMatchObject({
      sessionId: "session-1",
      aggregate: { inputTokens: "3", costMicros: "6", currency: "USD" },
      items: [{ providerId: "provider-1", providerAccountId: "account-1", commandId: "command-1" }],
    });

    const repository = await invokeHandler(
      handler,
      "GET",
      "/api/v1/usage?repositoryId=repo-1&providerId=provider-1&providerAccountId=account-1&commandId=command-1",
    );
    expect(repository.status).toBe(200);
    expect(repository.json).toMatchObject({
      aggregate: { inputTokens: "3", costMicros: "6", currency: "USD" },
      items: [{ sessionId: "session-1" }],
    });
    expect(
      (
        await invokeHandler(
          handler,
          "GET",
          "/api/v1/usage?repositoryId=repo-1&providerId=provider-1&providerAccountId=other",
        )
      ).json,
    ).toMatchObject({ aggregate: { reportCount: 0 }, items: [] });
    expect(
      (
        await invokeHandler(
          handler,
          "GET",
          "/api/v1/usage?repositoryId=repo-1&providerId=provider-1&providerAccountId=account-1&commandId=other",
        )
      ).json,
    ).toMatchObject({ aggregate: { reportCount: 0 }, items: [] });
    expect((await invokeHandler(handler, "GET", "/api/v1/sessions/missing/usage")).status).toBe(
      404,
    );
  });

  it("returns an internal error when a durable usage read fails", async () => {
    const plane = new ControlPlane();
    plane.state.sessions.set("session-1", {
      id: "session-1",
      repositoryId: "repo-1",
      attemptId: "a1",
      worktreeId: "w1",
    } as never);
    plane.state.storage = {
      getSession: async () => plane.state.sessions.get("session-1"),
      listUsageRecords: async () => {
        throw new Error("storage unavailable");
      },
    } as never;
    const { handler } = createLocalApp({ plane });
    expect((await invokeHandler(handler, "GET", "/api/v1/sessions/session-1/usage")).status).toBe(
      500,
    );
    expect((await invokeHandler(handler, "GET", "/api/v1/usage?repositoryId=repo-1")).status).toBe(
      500,
    );
  });
});
