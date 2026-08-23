import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

describe("schedule ref REST contract", () => {
  it("rejects tag/SHA refs for schedules but retains prompt-session refs", async () => {
    const plane = new ControlPlane({ scheduleIdFactory: () => "schedule" });
    plane.createCommand({ id: "command", name: "command", argv: ["echo"], providerId: null });
    plane.createRepository({ id: "repo", name: "repo", url: "https://example.test/repo" });
    const { handler } = createLocalApp({ plane });
    const invoke = (method: string, path: string, body?: unknown) =>
      invokeHandler(handler, method, path, body);
    const base = {
      repositoryId: "repo",
      name: "nightly",
      target: { commandId: "command" },
      cron: "0 0 * * *",
      timeout: 30,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    };

    expect(
      (await invoke("POST", "/api/v1/schedules", { ...base, ref: "refs/tags/v1" })).status,
    ).toBe(400);
    const created = await invoke("POST", "/api/v1/schedules", { ...base, ref: "main" });
    expect(created.status).toBe(201);
    const scheduleId = plane.listSchedules()[0]?.id;
    expect(scheduleId).toBeTruthy();
    expect((await invoke("GET", `/api/v1/schedules/${scheduleId}`)).status).toBe(200);
    expect(
      (await invoke("PATCH", `/api/v1/schedules/${scheduleId}`, { ref: "0123456789abcdef" }))
        .status,
    ).toBe(400);
    const prompt = await invoke("POST", "/api/v1/sessions", {
      repositoryId: "repo",
      prompt: "prompt ref remains flexible",
      target: { commandId: "command" },
      timeout: 30,
      ref: "0123456789abcdef",
    });
    expect(prompt).toMatchObject({ status: 201, json: { type: "prompt", source: "api" } });
    expect(
      (
        await invoke("POST", "/api/v1/sessions", {
          repositoryId: "repo",
          prompt: "bad type is ignored",
          target: { commandId: "command" },
          timeout: 30,
          type: "other",
        })
      ).json,
    ).toMatchObject({ type: "prompt", source: "api" });
  });
});
