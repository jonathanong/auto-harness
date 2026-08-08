import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeBadJson, invokeHandler } from "./local-server-test-helpers.ts";

describe("createLocalApp operator management REST", () => {
  it("repository schedule cancel and agent list via handlers", async () => {
    let n = 0;
    const plane = new ControlPlane({
      idFactory: () => `sess-${++n}`,
      now: () => "2026-01-01T00:00:00.000Z",
      publicBaseUrl: "http://ui",
      scheduleIdFactory: () => "sched-1",
      repositoryIdFactory: () => "repo-1",
    });
    const { handler } = createLocalApp({ plane });
    plane.seedWorktree({
      id: "wt-1",
      name: "wt-1",
      agentId: "a1",
      repositoryId: "r1",
      path: "/w",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.registerAgent({
      agentId: "a1",
      worktrees: [{ id: "wt-1", name: "wt-1", repositoryId: "r1", path: "/w", labels: [] }],
      commandProfiles: ["echo-prompt"],
      replaceExisting: true,
    });
    plane.createCommand({
      id: "cmd-echo",
      name: "echo-prompt",
      argv: ["echo"],
      providerId: null,
    });
    plane.createCommand({
      id: "cmd-codex",
      name: "codex-fix",
      argv: ["codex"],
      providerId: null,
    });

    const invoke = (method: string, path: string, body?: unknown) =>
      invokeHandler(handler, method, path, body);

    expect((await invoke("POST", "/api/v1/repositories", { name: "", url: "" })).status).toBe(400);
    expect(
      (await invoke("POST", "/api/v1/repositories", { name: "Demo", url: "/tmp/demo" })).status,
    ).toBe(400); // name must be a lowercase slug
    const repo = await invoke("POST", "/api/v1/repositories", {
      name: "demo",
      url: "/tmp/demo",
      defaultBranch: "main",
      setupScript: "s.sh",
      terminalHookScript: "h.sh",
    });
    expect(repo.status).toBe(201);
    expect(repo.json).toMatchObject({ id: "repo-1", name: "demo", url: "/tmp/demo" });
    expect((await invoke("GET", "/api/v1/repositories")).json).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: "repo-1" })]),
    });
    expect((await invoke("GET", "/api/v1/repositories/repo-1")).json).toMatchObject({
      id: "repo-1",
    });
    expect((await invoke("GET", "/api/v1/repositories/missing")).status).toBe(404);
    expect(
      (
        await invoke("PUT", "/api/v1/repositories/repo-1", {
          name: "demo2",
          url: "/tmp/d2",
          defaultBranch: "dev",
          setupScript: "s2.sh",
          terminalHookScript: "h2.sh",
        })
      ).json,
    ).toMatchObject({
      name: "demo2",
      defaultBranch: "dev",
      setupScript: "s2.sh",
      terminalHookScript: "h2.sh",
    });
    expect((await invoke("PUT", "/api/v1/repositories/nope", { name: "x" })).status).toBe(404);
    expect((await invoke("DELETE", "/api/v1/repositories/repo-1")).status).toBe(204);
    expect((await invoke("DELETE", "/api/v1/repositories/repo-1")).status).toBe(404);

    await invoke("POST", "/api/v1/repositories", {
      name: "demo",
      url: "/tmp/demo",
    });

    expect((await invoke("POST", "/api/v1/schedules", { name: "x" })).status).toBe(400);
    const sched = await invoke("POST", "/api/v1/schedules", {
      repositoryId: "repo-1",
      name: "nightly",
      commandId: "cmd-echo",
      cron: "0 0 * * *",
      timeout: 30,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      ref: "main",
      enabled: true,
    });
    expect(sched.status).toBe(201);
    expect(sched.json).toMatchObject({ id: "sched-1", name: "nightly" });
    expect((await invoke("GET", "/api/v1/schedules")).json).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: "sched-1" })]),
    });
    expect((await invoke("GET", "/api/v1/schedules/sched-1")).json).toMatchObject({
      name: "nightly",
    });
    expect((await invoke("GET", "/api/v1/schedules/nope")).status).toBe(404);
    expect(
      (
        await invoke("PATCH", "/api/v1/schedules/sched-1", {
          name: "nightly2",
          timeout: 45,
          commandId: "cmd-codex",
          cron: "0 1 * * *",
          nextRunAt: "2026-01-02T00:00:00.000Z",
          enabled: true,
          ref: "develop",
          repositoryId: "repo-1",
        })
      ).json,
    ).toMatchObject({
      name: "nightly2",
      timeout: 45,
      targetLabel: "codex-fix",
      ref: "develop",
    });
    expect((await invoke("PATCH", "/api/v1/schedules/nope", { name: "x" })).status).toBe(404);

    const triggered = await invoke("POST", "/api/v1/schedules/sched-1/trigger");
    expect(triggered.status).toBe(201);
    expect(triggered.json).toMatchObject({
      type: "scheduled",
      source: "schedule",
      prompt: "scheduled:nightly2",
      targetLabel: "codex-fix",
    });
    expect((await invoke("POST", "/api/v1/schedules/missing/trigger")).status).toBe(400);

    const created = await invoke("POST", "/api/v1/sessions", {
      repositoryId: "repo-1",
      prompt: "cancel-me",
      commandId: "cmd-echo",
      timeout: 10,
    });
    expect(created.status).toBe(201);
    const sid = (created.json as { id: string }).id;
    const cancelled = await invoke("POST", `/api/v1/sessions/${sid}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json).toMatchObject({ status: "cancelled" });
    expect((await invoke("POST", `/api/v1/sessions/${sid}/cancel`)).status).toBe(400);

    expect((await invoke("GET", "/api/v1/agents")).json).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ agentId: "a1" })]),
    });
    expect((await invoke("POST", "/api/v1/agents/drain", { agentId: "a1" })).status).toBe(200);

    const hostPut = await invoke("PUT", "/api/v1/agents/a1/config", {
      repositories: [
        {
          id: "repo-1",
          path: "/repo",
          defaultBranch: "main",
          worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: [] }],
        },
      ],
      commandProfiles: { "echo-prompt": { argv: ["echo"], appendPrompt: true } },
    });
    expect(hostPut.status).toBe(200);
    expect((await invoke("GET", "/api/v1/agents/a1/config")).status).toBe(200);
    expect((await invoke("GET", "/api/v1/agent-hosts")).json).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ agentId: "a1" })]),
    });
    expect((await invoke("DELETE", "/api/v1/agents/a1/config")).status).toBe(204);
    expect((await invoke("GET", "/api/v1/agents/a1/config")).status).toBe(404);

    expect((await invoke("DELETE", "/api/v1/schedules/sched-1")).status).toBe(204);
    expect((await invoke("DELETE", "/api/v1/schedules/sched-1")).status).toBe(404);

    expect(await invokeBadJson(handler, "POST", "/api/v1/repositories")).toBe(400);
    expect(await invokeBadJson(handler, "PUT", "/api/v1/repositories/repo-1")).toBe(400);
    expect(await invokeBadJson(handler, "POST", "/api/v1/schedules")).toBe(400);
    expect(await invokeBadJson(handler, "PATCH", "/api/v1/schedules/sched-1")).toBe(400);
  });
});
