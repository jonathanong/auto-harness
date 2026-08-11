import { describe, expect, it } from "vitest";

import { buildSessionRecord, validateSessionCreate } from "./control-plane-session-create.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

describe("session creation preparation", () => {
  it("rejects malformed bodies and unknown targets", () => {
    const state = createControlPlaneState();
    expect(validateSessionCreate(state, null)).toMatchObject({ ok: false });
    expect(
      validateSessionCreate(state, {
        repositoryId: "repo-1",
        prompt: "work",
        target: { commandId: "missing" },
        timeout: 30,
      }),
    ).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
  });

  it("omits schedule provenance for ordinary sessions", () => {
    const state = createControlPlaneState({
      idFactory: () => "session-1",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    state.commands.set("command-1", {
      id: "command-1",
      name: "command",
      argv: ["command"],
      appendPrompt: true,
      providerId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const prepared = validateSessionCreate(state, {
      repositoryId: "repo-1",
      prompt: "work",
      target: { commandId: "command-1" },
      timeout: 30,
      scheduleId: "caller-controlled-value",
    });

    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) throw new Error(prepared.error);
    expect(buildSessionRecord(state, prepared)).not.toHaveProperty("scheduleId");
  });

  it("preserves allowed schedule provenance and optional create fields", () => {
    const state = createControlPlaneState({
      idFactory: () => "session-2",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 2,
    });
    state.commands.set("command-1", {
      id: "command-1",
      name: "command",
      argv: ["command"],
      appendPrompt: true,
      providerId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    const prepared = validateSessionCreate(
      state,
      {
        repositoryId: "repo-1",
        prompt: "work",
        target: { commandId: "command-1" },
        timeout: 30,
        scheduleId: "schedule-1",
        ref: "feature",
        concurrencyId: "lock-1",
        metadata: { source: "test" },
      },
      { allowScheduleId: true },
    );
    if (!prepared.ok) throw new Error(prepared.error);
    expect(buildSessionRecord(state, prepared)).toMatchObject({
      scheduleId: "schedule-1",
      ref: "feature",
      concurrencyId: "lock-1",
      metadata: { source: "test" },
    });
  });
});
