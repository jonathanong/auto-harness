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

describe("scoped control-plane REST resources", () => {
  it("hides cross-repository and cross-host resources with indistinguishable 404s", async () => {
    const plane = new ControlPlane({
      idFactory: (() => {
        let n = 0;
        return () => `session-${++n}`;
      })(),
    });
    plane.createRepository({ id: "repo-a", name: "repo-a", url: "/a" });
    plane.createRepository({ id: "repo-b", name: "repo-b", url: "/b" });
    plane.createCommand({ id: "cmd-a", name: "echo", argv: ["echo"], providerId: null });
    plane.putSchedule({
      id: "schedule-a",
      repositoryId: "repo-a",
      name: "nightly",
      commandId: "cmd-a",
      cron: "* * * * *",
      timeout: 10,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    plane.putSchedule({
      id: "schedule-b",
      repositoryId: "repo-b",
      name: "nightly",
      commandId: "cmd-a",
      cron: "* * * * *",
      timeout: 10,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    plane.seedWorktree({
      id: "wt-a",
      name: "wt-a",
      hostId: "host-a",
      repositoryId: "repo-a",
      path: "/a/wt",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.seedWorktree({
      id: "wt-b",
      name: "wt-b",
      hostId: "host-b",
      repositoryId: "repo-b",
      path: "/b/wt",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.createSession({ repositoryId: "repo-a", prompt: "a", commandId: "cmd-a", timeout: 10 });
    plane.createSession({ repositoryId: "repo-b", prompt: "b", commandId: "cmd-a", timeout: 10 });
    const sessionB = plane.listSessions().find((session) => session.repositoryId === "repo-b")!;

    const auth = new AuthService({ mode: "required", secret: "secret", admins: admins() });
    const { apiKey } = await auth.createServiceAccount({
      name: "scoped-agent",
      role: "operator",
      allowedRepositoryIds: ["repo-a"],
      boundHostId: "host-a",
    });
    const { apiKey: adminKey } = await auth.createServiceAccount({
      name: "host-admin",
      role: "admin",
      boundHostId: "host-a",
    });
    const { handler } = createLocalApp({ plane, authService: auth });
    const invoke = (method: string, path: string, body?: unknown, key = apiKey) =>
      invokeHandler(handler, method, path, body, { authorization: `Bearer ${key}` });

    expect((await invoke("GET", "/api/v1/repositories")).json).toMatchObject({
      items: [expect.objectContaining({ id: "repo-a" })],
    });
    expect((await invoke("GET", "/api/v1/repositories/repo-b")).status).toBe(404);
    expect((await invoke("GET", "/api/v1/schedules")).json).toMatchObject({
      items: [expect.objectContaining({ id: "schedule-a" })],
    });
    expect((await invoke("GET", "/api/v1/schedules/schedule-b")).status).toBe(404);
    expect(
      (await invoke("PATCH", "/api/v1/schedules/schedule-a", { repositoryId: "repo-b" })).status,
    ).toBe(404);
    expect(
      (await invoke("PATCH", "/api/v1/schedules/schedule-a", { name: "renamed" })).status,
    ).toBe(200);
    expect(
      (
        await invoke("POST", "/api/v1/schedules", {
          repositoryId: "repo-a",
          name: "explicit",
          commandId: "cmd-a",
          cron: "* * * * *",
          timeout: 10,
          nextRunAt: "2026-01-01T00:00:00.000Z",
          enabled: false,
          ref: "main",
          id: "schedule-c",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await invoke("PATCH", "/api/v1/schedules/schedule-c", {
          name: "explicit-2",
          providerAccountId: "missing-account",
          commandId: "cmd-a",
          cron: "0 * * * *",
          timeout: 20,
          nextRunAt: "2026-01-02T00:00:00.000Z",
          enabled: true,
          ref: "develop",
          repositoryId: "repo-a",
        })
      ).status,
    ).toBe(200);
    expect((await invoke("GET", "/api/v1/worktrees")).json).toMatchObject({
      items: [expect.objectContaining({ id: "wt-a" })],
    });
    expect((await invoke("GET", "/api/v1/hosts")).json).toMatchObject({
      items: [expect.objectContaining({ hostId: "host-a" })],
    });
    expect(
      (await invoke("POST", "/api/v1/hosts/drain", { hostId: "host-b" }, adminKey)).status,
    ).toBe(404);
    expect((await invoke("POST", "/api/v1/schedules/schedule-b/trigger")).status).toBe(404);
    expect(
      (
        await invoke(
          "POST",
          "/api/v1/repositories",
          {
            name: "repo-c",
            url: "/c",
            defaultBranch: "main",
            setupScript: "setup",
            terminalHookScript: "hook",
          },
          adminKey,
        )
      ).status,
    ).toBe(201);
    expect((await invoke("GET", `/api/v1/sessions/${sessionB.id}`)).status).toBe(404);
    expect((await invoke("POST", `/api/v1/sessions/${sessionB.id}/cancel`)).status).toBe(404);
    expect((await invoke("GET", `/api/v1/sessions/${sessionB.id}/logs`)).status).toBe(404);
    expect((await invoke("POST", `/api/v1/sessions/${sessionB.id}/archive`)).status).toBe(404);
    expect((await invoke("GET", "/api/v1/hosts/host-b/inventory")).status).toBe(404);
  });
});
