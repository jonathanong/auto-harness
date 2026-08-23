import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { setInMemoryScheduleStorage } from "./control-plane-durable-read-test-helpers.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";

describe("legacy schedule ownership", () => {
  it("claims a legacy schedule from the authenticated editor and persists the owner", async () => {
    const plane = new ControlPlane({ now: () => NOW });
    plane.state.repositories.set("repository", {
      id: "repository",
      name: "repository",
      url: "/repository",
      defaultBranch: "main",
      createdAt: NOW,
      updatedAt: NOW,
    });
    plane.state.commands.set("command", {
      id: "command",
      name: "command",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    plane.state.schedules.set("schedule", {
      id: "schedule",
      repositoryId: "repository",
      name: "schedule",
      target: { commandId: "command" },
      fallbacks: [],
      targetLabels: ["command"],
      cron: "* * * * *",
      enabled: true,
      timeout: 60,
      queueTtlSeconds: 3600,
      nextRunAt: "2026-01-01T00:01:00.000Z",
      lastRunAt: null,
      createdAt: NOW,
    });
    setInMemoryScheduleStorage(plane.state);

    const auth = new AuthService({
      mode: "required",
      secret: "a".repeat(32),
      admins: Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
        "base64url",
      ),
    });
    const { account, apiKey } = await auth.createServiceAccount({
      name: "schedule-editor",
      role: "operator",
      allowedRepositoryIds: ["repository"],
    });
    const { handler } = createLocalApp({
      plane,
      authService: auth,
      rateLimitConfig: { enabled: false },
    });

    const response = await invokeHandler(
      handler,
      "PATCH",
      "/api/v1/schedules/schedule",
      { name: "claimed schedule" },
      { authorization: `Bearer ${apiKey}` },
    );

    expect(response).toMatchObject({ status: 200, json: { principalId: account.id } });
    expect(plane.getSchedule("schedule")).toMatchObject({ principalId: account.id });
    expect(plane.getSchedule("schedule")).toMatchObject({ principalId: account.id });

    const created = await invokeHandler(
      handler,
      "POST",
      "/api/v1/schedules",
      {
        id: "new-schedule",
        repositoryId: "repository",
        name: "new schedule",
        target: { commandId: "command" },
        cron: "* * * * *",
        timeout: 60,
      },
      { authorization: `Bearer ${apiKey}` },
    );
    expect(created).toMatchObject({ status: 201, json: { principalId: account.id } });
    expect(plane.getSchedule("new-schedule")).toMatchObject({ principalId: account.id });
  });

  it("uses the system principal when authentication is disabled", async () => {
    const plane = new ControlPlane({ now: () => NOW });
    plane.state.repositories.set("repository", {
      id: "repository",
      name: "repository",
      url: "/repository",
      defaultBranch: "main",
      createdAt: NOW,
      updatedAt: NOW,
    });
    plane.state.commands.set("command", {
      id: "command",
      name: "command",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    setInMemoryScheduleStorage(plane.state);

    const { handler } = createLocalApp({
      plane,
      authMode: "disabled",
      rateLimitConfig: { enabled: false },
    });
    const created = await invokeHandler(handler, "POST", "/api/v1/schedules", {
      id: "new-schedule",
      repositoryId: "repository",
      name: "new schedule",
      target: { commandId: "command" },
      cron: "* * * * *",
      timeout: 60,
    });

    expect(created).toMatchObject({ status: 201, json: { principalId: "system" } });
    expect(plane.getSchedule("new-schedule")).toMatchObject({ principalId: "system" });
  });
});
