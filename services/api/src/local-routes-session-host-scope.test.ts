import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

function admins(): string {
  return Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
    "base64url",
  );
}

/**
 * Host-bound admins used to pass canCancelSession (any admin) and skip the
 * host fence that GET session/logs/usage already apply. A stolen host admin
 * key could cancel or archive work assigned to another VPS.
 */
describe("host-bound session mutations stay on the bound host", () => {
  async function harness() {
    const plane = new ControlPlane({
      idFactory: (() => {
        let n = 0;
        return () => `session-${++n}`;
      })(),
    });
    plane.createRepository({ id: "repo-a", name: "repo-a", url: "/a" });
    plane.createCommand({ id: "cmd-a", name: "echo", argv: ["echo"], providerId: null });
    const own = plane.createSession({
      repositoryId: "repo-a",
      prompt: "own",
      target: { commandId: "cmd-a" },
      timeout: 10,
    });
    const foreign = plane.createSession({
      repositoryId: "repo-a",
      prompt: "foreign",
      target: { commandId: "cmd-a" },
      timeout: 10,
    });
    if (!own.ok || !foreign.ok) throw new Error("failed to create sessions");
    const ownRecord = plane.state.sessions.get(own.session.id);
    const foreignRecord = plane.state.sessions.get(foreign.session.id);
    if (!ownRecord || !foreignRecord) throw new Error("sessions missing from cache");
    ownRecord.hostId = "host-a";
    foreignRecord.hostId = "host-b";

    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const { apiKey } = await auth.createServiceAccount({
      name: "host-a-admin",
      role: "admin",
      boundHostId: "host-a",
    });
    const { handler } = createLocalApp({
      plane,
      authService: auth,
      rateLimitConfig: { enabled: false },
    });
    const invoke = (method: string, path: string, body?: unknown) =>
      invokeHandler(handler, method, path, body, { authorization: `Bearer ${apiKey}` });
    return { plane, invoke, own: own.session, foreign: foreign.session };
  }

  it("refuses cancel and archive of a session assigned to another host", async () => {
    const { invoke, own, foreign } = await harness();

    expect((await invoke("POST", `/api/v1/sessions/${foreign.id}/cancel`)).status).toBe(404);
    expect((await invoke("POST", `/api/v1/sessions/${foreign.id}/archive`)).status).toBe(404);

    // Archive while the session still carries hostId — cancel clears the assignment.
    expect((await invoke("POST", `/api/v1/sessions/${own.id}/archive`)).status).toBe(200);
    expect((await invoke("POST", `/api/v1/sessions/${own.id}/cancel`)).status).toBe(200);
  });
});
