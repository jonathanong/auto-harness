import { describe, expect, it } from "vitest";

import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";
import { auditFixture } from "./audit-test-helpers.ts";

async function expectAudit(
  plane: ReturnType<typeof auditFixture>,
  action: string,
  outcome: "success" | "failed" | "denied",
  count = 1,
): Promise<void> {
  expect((await plane.listAuditLogs({ action, outcome })).items).toHaveLength(count);
}

function terminalResumeFixture() {
  const plane = auditFixture();
  plane.state.idFactory = () => "resumed-a";
  const source = plane.state.sessions.get("session-a");
  if (!source) throw new Error("missing resume source");
  source.concurrencyId = "resume-lock";
  source.resolvedRoute = {
    targetIndex: 0,
    commandId: "command-a",
    hostId: "agent-a",
    worktreeId: "worktree-a",
    attemptId: "attempt-a",
  };
  expect(plane.forceStatus(source.id, "completed")).not.toBeNull();
  return plane;
}

describe("audited real route outcomes", () => {
  it("records repository and schedule success and failure outcomes without replacing handlers", async () => {
    const routes = [
      [
        "PATCH",
        "/api/v1/repositories/repository-a",
        { name: "not a slug" },
        404,
        "repository:update",
        "failed",
      ],
      [
        "PATCH",
        "/api/v1/repositories/missing",
        { name: "renamed" },
        404,
        "repository:update",
        "failed",
      ],
      [
        "DELETE",
        "/api/v1/repositories/repository-a",
        undefined,
        204,
        "repository:delete",
        "success",
      ],
      ["DELETE", "/api/v1/repositories/missing", undefined, 404, "repository:delete", "failed"],
      [
        "POST",
        "/api/v1/schedules",
        {
          repositoryId: "repository-a",
          name: "bad",
          target: { commandId: "missing" },
          cron: "* * * * *",
          timeout: 60,
        },
        400,
        "schedule:create",
        "failed",
      ],
      [
        "PATCH",
        "/api/v1/schedules/schedule-a",
        { target: { commandId: "missing" } },
        400,
        "schedule:update",
        "failed",
      ],
      ["DELETE", "/api/v1/schedules/schedule-a", undefined, 204, "schedule:delete", "success"],
      ["DELETE", "/api/v1/schedules/missing", undefined, 404, "schedule:delete", "failed"],
      ["POST", "/api/v1/schedules/missing/trigger", undefined, 404, "schedule:trigger", "failed"],
    ] as const;

    for (const [method, path, body, status, action, outcome] of routes) {
      const plane = auditFixture();
      if (method === "DELETE" && path === "/api/v1/repositories/repository-a") {
        plane.state.schedules.clear();
        plane.state.sessions.clear();
      }
      const response = await invokeHandler(
        createLocalApp({ plane, authMode: "disabled" }).handler,
        method,
        path,
        body,
      );
      expect(response.status, path).toBe(status);
      await expectAudit(plane, action, outcome);
    }

    const trigger = auditFixture();
    const handler = createLocalApp({ plane: trigger, authMode: "disabled" }).handler;
    expect(
      (await invokeHandler(handler, "POST", "/api/v1/schedules/schedule-a/trigger")).status,
    ).toBe(201);
    expect(
      (await invokeHandler(handler, "POST", "/api/v1/schedules/schedule-a/trigger")).status,
    ).toBe(200);
    await expectAudit(trigger, "schedule:trigger", "success", 2);

    const disabled = auditFixture();
    expect((await disabled.updateScheduleDurable("schedule-a", { enabled: false })).ok).toBe(true);
    expect(
      (
        await invokeHandler(
          createLocalApp({ plane: disabled, authMode: "disabled" }).handler,
          "POST",
          "/api/v1/schedules/schedule-a/trigger",
        )
      ).status,
    ).toBe(409);
    await expectAudit(disabled, "schedule:trigger", "failed");
  });

  it("maps real resume races, missing sources, and validation failures while recording outcomes", async () => {
    const missing = auditFixture();
    const missingResponse = await invokeHandler(
      createLocalApp({ plane: missing, authMode: "disabled" }).handler,
      "POST",
      "/api/v1/sessions/missing/resume",
    );
    expect(missingResponse.status).toBe(404);
    expect((missingResponse.json as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    await expectAudit(missing, "session:resume", "denied");

    const active = auditFixture();
    expect(
      (
        await invokeHandler(
          createLocalApp({ plane: active, authMode: "disabled" }).handler,
          "POST",
          "/api/v1/sessions/session-a/resume",
        )
      ).status,
    ).toBe(409);
    await expectAudit(active, "session:resume", "failed");

    const noAgent = auditFixture();
    expect(noAgent.forceStatus("session-a", "completed")).not.toBeNull();
    expect(
      (
        await invokeHandler(
          createLocalApp({ plane: noAgent, authMode: "disabled" }).handler,
          "POST",
          "/api/v1/sessions/session-a/resume",
        )
      ).status,
    ).toBe(409);
    await expectAudit(noAgent, "session:resume", "failed");

    const scheduled = terminalResumeFixture();
    const source = scheduled.state.sessions.get("session-a")!;
    source.type = "scheduled";
    source.principalId = "system";
    expect(
      (
        await invokeHandler(
          createLocalApp({ plane: scheduled, authMode: "disabled" }).handler,
          "POST",
          "/api/v1/sessions/session-a/resume",
        )
      ).status,
    ).toBe(409);
    await expectAudit(scheduled, "session:resume", "failed");

    const invalidContinuation = terminalResumeFixture();
    invalidContinuation.state.sessions.get("session-a")!.resumeSpec = {
      argv: ["tool"],
      appendPrompt: true,
      resumeArgvTemplate: ["tool", "resume", "{cliResumeRef}"],
    };
    const invalid = await invokeHandler(
      createLocalApp({ plane: invalidContinuation, authMode: "disabled" }).handler,
      "POST",
      "/api/v1/sessions/session-a/resume",
    );
    expect(invalid.status).toBe(400);
    expect((invalid.json as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
    await expectAudit(invalidContinuation, "session:resume", "failed");

    const race = terminalResumeFixture();
    const handler = createLocalApp({ plane: race, authMode: "disabled" }).handler;
    expect((await invokeHandler(handler, "POST", "/api/v1/sessions/session-a/resume")).status).toBe(
      201,
    );
    const duplicate = await invokeHandler(handler, "POST", "/api/v1/sessions/session-a/resume");
    expect(duplicate.status).toBe(200);
    expect(duplicate.json).toMatchObject({ id: "resumed-a", created: false });
    await expectAudit(race, "session:resume", "success", 2);
  });
});
