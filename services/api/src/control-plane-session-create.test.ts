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

  it("validates workspace pool and setup profile references and copies workspace defaults", () => {
    const state = createControlPlaneState({
      idFactory: () => "workspace-session",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    state.commands.set("command-1", {
      id: "command-1",
      name: "command",
      argv: ["command"],
      appendPrompt: true,
      providerId: null,
    });
    state.workspacePools.set("pool-1", {
      id: "pool-1",
      name: "workspace",
      setupProfiles: [{ id: "install", name: "Install", script: "pnpm install" }],
      defaultSetupProfileId: "install",
      destroyWorkspaceAfter: true,
      createdAt: "t",
      updatedAt: "t",
    });
    const base = {
      repositoryId: null,
      workspacePoolId: "pool-1",
      prompt: "inspect",
      target: { commandId: "command-1" },
      timeout: 30,
      type: "workspace",
      source: "api",
    };
    expect(validateSessionCreate(state, { ...base, workspacePoolId: "missing" })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(validateSessionCreate(state, { ...base, setupProfileId: "missing" })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    const prepared = validateSessionCreate(state, base);
    if (!prepared.ok) throw new Error(prepared.error);
    expect(buildSessionRecord(state, prepared)).toMatchObject({
      repositoryId: "",
      workspacePoolId: "pool-1",
      destroyWorkspaceAfter: true,
      type: "workspace",
    });
  });
});
