/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeBadJson, invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

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
      hostId: "a1",
      repositoryId: "r1",
      path: "/w",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.registerHost({
      hostId: "a1",
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
      (
        await invoke("POST", "/api/v1/repositories", {
          name: "Demo",
          url: "https://example.test/demo.git",
        })
      ).status,
    ).toBe(400); // name must be a lowercase slug
    const repo = await invoke("POST", "/api/v1/repositories", {
      name: "demo",
      url: "https://example.test/demo.git",
      defaultBranch: "main",
      setupScript: "s.sh",
      terminalHookScript: "h.sh",
    });
    expect(repo.status).toBe(201);
    expect(repo.json).toMatchObject({
      id: "repo-1",
      name: "demo",
      url: "https://example.test/demo.git",
    });
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
          url: "https://example.test/demo2.git",
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
      url: "https://example.test/demo.git",
    });

    expect((await invoke("POST", "/api/v1/schedules", { name: "x" })).status).toBe(400);
    expect(
      (
        await invoke("POST", "/api/v1/schedules", {
          repositoryId: "repo-1",
          name: "missing-target",
          target: null,
          cron: "* * * * *",
          timeout: 1,
          nextRunAt: "2026-01-01T00:00:00.000Z",
        })
      ).status,
    ).toBe(400);
    const sched = await invoke("POST", "/api/v1/schedules", {
      repositoryId: "repo-1",
      name: "nightly",
      target: { commandId: "cmd-echo" },
      fallbacks: [{ commandId: "cmd-codex" }],
      cron: "0 0 * * *",
      timeout: 30,
      queueTtlSeconds: 10,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      ref: "main",
      enabled: true,
      prompt: "run nightly checks",
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
          target: { commandId: "cmd-codex" },
          fallbacks: [],
          cron: "0 1 * * *",
          nextRunAt: "2026-01-02T00:00:00.000Z",
          queueTtlSeconds: 20,
          enabled: true,
          ref: "develop",
          repositoryId: "repo-1",
        })
      ).json,
    ).toMatchObject({
      name: "nightly2",
      timeout: 45,
      targetDisplayNames: ["codex-fix"],
      ref: "develop",
      queueTtlSeconds: 20,
    });
    expect((await invoke("PATCH", "/api/v1/schedules/nope", { name: "x" })).status).toBe(404);
    expect(
      (
        await invoke("PATCH", "/api/v1/schedules/sched-1", {
          target: { commandId: "missing" },
        })
      ).status,
    ).toBe(400);
    expect(await invokeBadJson(handler, "PATCH", "/api/v1/schedules/sched-1")).toBe(400);

    const triggered = await invoke("POST", "/api/v1/schedules/sched-1/trigger");
    expect(triggered.status).toBe(201);
    expect(triggered.json).toMatchObject({
      type: "scheduled",
      source: "schedule",
      prompt: "run nightly checks",
      targetDisplayNames: ["codex-fix"],
    });
    expect((await invoke("PATCH", "/api/v1/schedules/sched-1", { enabled: false })).status).toBe(
      200,
    );
    expect((await invoke("POST", "/api/v1/schedules/sched-1/trigger")).status).toBe(409);
    expect((await invoke("PATCH", "/api/v1/schedules/sched-1", { enabled: true })).status).toBe(
      200,
    );
    expect((await invoke("POST", "/api/v1/schedules/missing/trigger")).status).toBe(404);
    expect((await invoke("POST", "/api/v1/schedules/sched-1")).status).toBe(404);
    expect((await invoke("POST", "/api/v1/schedules/sched-1")).status).toBe(404);

    const created = await invoke("POST", "/api/v1/sessions", {
      repositoryId: "repo-1",
      prompt: "cancel-me",
      target: { commandId: "cmd-echo" },
      timeout: 10,
    });
    expect(created.status).toBe(201);
    const sid = (created.json as { id: string }).id;
    expect((await invoke("GET", "/api/v1/repositories")).json).toMatchObject({
      items: [
        expect.objectContaining({
          id: "repo-1",
          sessionCount: 2,
          worktreeCount: 0,
          scheduleCount: 1,
        }),
      ],
    });
    const cancelled = await invoke("POST", `/api/v1/sessions/${sid}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json).toMatchObject({ status: "cancelled" });
    expect((await invoke("POST", `/api/v1/sessions/${sid}/cancel`)).status).toBe(409);

    expect((await invoke("GET", "/api/v1/hosts")).json).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ hostId: "a1" })]),
    });
    expect((await invoke("POST", "/api/v1/hosts/drain", { hostId: "a1" })).status).toBe(200);

    const hostPut = await invoke("PUT", "/api/v1/hosts/a1/inventory", {
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
    expect((await invoke("GET", "/api/v1/hosts/a1/inventory")).status).toBe(200);
    expect((await invoke("GET", "/api/v1/host-inventories")).json).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ hostId: "a1" })]),
    });
    expect((await invoke("DELETE", "/api/v1/hosts/a1/inventory")).status).toBe(204);
    expect((await invoke("GET", "/api/v1/hosts/a1/inventory")).status).toBe(404);

    expect((await invoke("DELETE", "/api/v1/schedules/sched-1")).status).toBe(204);
    expect((await invoke("DELETE", "/api/v1/schedules/sched-1")).status).toBe(404);

    expect(await invokeBadJson(handler, "POST", "/api/v1/repositories")).toBe(400);
    expect(await invokeBadJson(handler, "PUT", "/api/v1/repositories/repo-1")).toBe(400);
    expect(await invokeBadJson(handler, "POST", "/api/v1/schedules")).toBe(400);
  });

  it.each(["PUT", "PATCH"] as const)(
    "classifies rejected repository %s requests without mutating the repository",
    async (method) => {
      let repositoryNumber = 0;
      const plane = new ControlPlane({
        repositoryIdFactory: () => `repo-${++repositoryNumber}`,
      });
      const { handler } = createLocalApp({ plane });
      const invoke = (path: string, body: unknown) => invokeHandler(handler, method, path, body);
      const getRepository = (id: string) =>
        invokeHandler(handler, "GET", `/api/v1/repositories/${id}`);

      const first = await invokeHandler(handler, "POST", "/api/v1/repositories", {
        name: "first",
        url: "https://example.test/first.git",
      });
      const second = await invokeHandler(handler, "POST", "/api/v1/repositories", {
        name: "second",
        url: "https://example.test/second.git",
      });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const firstRepository = first.json as { id: string };

      const invalidUrl = "not-a-repository-url";
      const invalid = await invoke(`/api/v1/repositories/${firstRepository.id}`, {
        url: invalidUrl,
      });
      expect(invalid).toMatchObject({
        status: 400,
        json: { error: { code: "VALIDATION_ERROR" } },
      });
      expect(JSON.stringify(invalid.json)).not.toContain(invalidUrl);
      expect(await getRepository(firstRepository.id)).toMatchObject({
        status: 200,
        json: { name: "first", url: "https://example.test/first.git" },
      });

      for (const field of [
        "name",
        "url",
        "defaultBranch",
        "setupScript",
        "terminalHookScript",
      ] as const) {
        const invalidFieldType = await invoke(`/api/v1/repositories/${firstRepository.id}`, {
          [field]: 42,
        });
        expect(invalidFieldType).toMatchObject({
          status: 400,
          json: { error: { code: "VALIDATION_ERROR", message: `${field} must be a string` } },
        });
      }

      const invalidBody = await invoke(`/api/v1/repositories/${firstRepository.id}`, null);
      expect(invalidBody).toMatchObject({
        status: 400,
        json: {
          error: {
            code: "VALIDATION_ERROR",
            message: "repository update body must be an object",
          },
        },
      });

      const duplicate = await invoke(`/api/v1/repositories/${firstRepository.id}`, {
        name: "second",
      });
      expect(duplicate).toMatchObject({
        status: 409,
        json: { error: { code: "CONFLICT" } },
      });
      expect(await getRepository(firstRepository.id)).toMatchObject({
        status: 200,
        json: { name: "first", url: "https://example.test/first.git" },
      });

      const missing = await invoke("/api/v1/repositories/missing", { name: "third" });
      expect(missing).toMatchObject({
        status: 404,
        json: { error: { code: "NOT_FOUND" } },
      });
      expect(
        (await plane.listAuditLogs({ action: "repository:update", outcome: "failed" })).items,
      ).toHaveLength(9);
    },
  );

  it("rejects and audits malformed repository create bodies", async () => {
    const plane = new ControlPlane();
    const { handler } = createLocalApp({ plane });
    const create = (body: unknown) => invokeHandler(handler, "POST", "/api/v1/repositories", body);

    for (const field of [
      "name",
      "url",
      "defaultBranch",
      "setupScript",
      "terminalHookScript",
    ] as const) {
      const response = await create({
        name: "demo",
        url: "https://example.test/demo.git",
        [field]: field === "url" ? ["https://example.test/demo.git"] : 42,
      });
      expect(response).toMatchObject({
        status: 400,
        json: { error: { code: "VALIDATION_ERROR", message: `${field} must be a string` } },
      });
    }
    expect(await create(null)).toMatchObject({
      status: 400,
      json: {
        error: {
          code: "VALIDATION_ERROR",
          message: "repository create body must be an object",
        },
      },
    });
    expect(
      (await plane.listAuditLogs({ action: "repository:create", outcome: "failed" })).items,
    ).toHaveLength(6);
  });
});
