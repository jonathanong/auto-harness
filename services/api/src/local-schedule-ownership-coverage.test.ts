import { describe, expect, it } from "vitest";

import { setInMemoryScheduleStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";

describe("legacy schedule ownership", () => {
  it("uses the system principal when authentication is disabled", async () => {
    const plane = new ControlPlane({ now: () => NOW });
    plane.state.repositories.set("repository", {
      id: "repository",
      name: "repository",
      url: "/repository",
      defaultBranch: "main",
      admissionState: "active",
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
