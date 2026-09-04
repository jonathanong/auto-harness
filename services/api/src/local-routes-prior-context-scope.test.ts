import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";
import { minimalSession } from "./control-plane-prior-context-test-helpers.ts";

function admins(): string {
  return Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
    "base64url",
  );
}

describe("GET /sessions/:id/prior-context host scoping", () => {
  it("scopes access to the running session's own bound host", async () => {
    const plane = new ControlPlane({ shardCount: 1 });
    plane.createRepository({ id: "repo-a", name: "repo-a", url: "/a" });
    plane.createCommand({ id: "cmd-a", name: "echo", argv: ["echo"], providerId: null });
    plane.state.sessions.set(
      "source",
      minimalSession({ id: "source", repositoryId: "repo-a", target: { commandId: "cmd-a" } }),
    );
    plane.state.logs.set("source", [
      {
        sessionId: "source",
        timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
        stream: "stdout",
        content: "prior output",
        timestamp: "2026-01-01T00:00:00.000Z",
        seq: 1,
      },
    ]);
    plane.state.sessions.set(
      "running",
      minimalSession({
        id: "running",
        repositoryId: "repo-a",
        target: { commandId: "cmd-a" },
        status: "running",
        hostId: "host-a",
        resumedFromSessionId: "source",
      }),
    );

    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const { apiKey: ownHostKey } = await auth.createServiceAccount({
      name: "host-a-agent",
      role: "agent",
      allowedRepositoryIds: ["repo-a"],
      boundHostId: "host-a",
    });
    const { apiKey: otherHostKey } = await auth.createServiceAccount({
      name: "host-b-agent",
      role: "agent",
      allowedRepositoryIds: ["repo-a"],
      boundHostId: "host-b",
    });
    const { handler } = createLocalApp({
      plane,
      authService: auth,
      rateLimitConfig: { enabled: false },
    });
    const invoke = (key: string) =>
      invokeHandler(handler, "GET", "/api/v1/sessions/running/prior-context", undefined, {
        authorization: `Bearer ${key}`,
      });

    const own = await invoke(ownHostKey);
    expect(own.status).toBe(200);
    expect((own.json as { content: string }).content).toContain("prior output");

    const other = await invoke(otherHostKey);
    expect(other.status).toBe(404);
  });
});
