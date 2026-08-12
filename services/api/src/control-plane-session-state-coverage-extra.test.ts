import { describe, expect, it } from "vitest";

import { cancelSessionDurable } from "./control-plane-cancel-durable.ts";
import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { buildSessionRecord, validateSessionCreate } from "./control-plane-session-create.ts";
import { cloneSessionDurable, resumeSessionDurable } from "./control-plane-sessions-durable.ts";
import { createSession, supersedeSession } from "./control-plane-sessions.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function row(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetLabels: ["cmd"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "queued",
    queueShard: 0,
    createdAt: NOW,
    type: "prompt",
    source: "api",
    ...over,
  };
}

function commandState() {
  const state = createControlPlaneState({ idFactory: () => "new", now: () => NOW });
  state.commands.set("cmd", {
    id: "cmd",
    name: "command",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
  });
  return state;
}

describe("session state-machine residual coverage", () => {
  it("rejects durable cancellation when a running main-checkout lost its fence", async () => {
    const state = commandState();
    setDurableReadStorage(state, {});
    state.sessions.set("s", row({ status: "running", mainCheckoutLease: true, hostId: null }));

    await expect(cancelSessionDurable(state, "s")).resolves.toEqual({
      ok: false,
      error: "session changed before cancellation",
    });
  });

  it("rejects unresolved create targets in both preparation paths", () => {
    const state = createControlPlaneState();
    const body = {
      repositoryId: "repo",
      prompt: "run",
      target: { commandId: "missing" },
      timeout: 30,
    };
    expect(validateSessionCreate(state, body)).toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
    });
    expect(createSession(state, body)).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
  });

  it("keeps trusted schedule provenance during durable preparation", () => {
    const prepared = validateSessionCreate(
      commandState(),
      {
        repositoryId: "repo",
        prompt: "run",
        target: { commandId: "cmd" },
        timeout: 30,
        scheduleId: "nightly",
      },
      { allowScheduleId: true },
    );
    expect(prepared).toMatchObject({ ok: true, scheduleId: "nightly" });
    if (!prepared.ok) throw new Error("expected prepared session");
    expect(buildSessionRecord(commandState(), prepared).scheduleId).toBe("nightly");
  });

  it("authoritatively checks a missing durable resume source", async () => {
    const state = commandState();
    setDurableReadStorage(state, { getSession: async () => null });
    await expect(resumeSessionDurable(state, "missing")).resolves.toEqual({
      ok: false,
      error: "session not found",
    });
  });

  it("persists an ordinary queued supersession without a concurrency lock", () => {
    const state = commandState();
    state.sessions.set("s", row());
    supersedeSession(state, "s", "superseded");
    expect(state.sessions.get("s")).toMatchObject({
      status: "cancelled",
      errorMessage: "superseded",
      worktreeId: null,
      hostId: null,
    });
  });

  it("maps a durable clone id collision to a public conflict", async () => {
    const state = commandState();
    const source = row({ status: "completed", completedAt: NOW });
    const conflict = new Error("collision");
    conflict.name = "SessionIdCollisionError";
    setDurableReadStorage(state, {
      getSession: async () => source,
      createSession: async () => {
        throw conflict;
      },
    });
    await expect(cloneSessionDurable(state, "s")).resolves.toEqual({
      ok: false,
      error: "clone creation conflicted; retry the request",
      code: "CONFLICT",
    });
    state.storage!.createSession = async () => {
      throw new Error("storage unavailable");
    };
    await expect(cloneSessionDurable(state, "s")).rejects.toThrow("storage unavailable");
  });

  it("rejects a missing durable clone source before preparing it", async () => {
    const state = commandState();
    setDurableReadStorage(state, { getSession: async () => null });
    await expect(cloneSessionDurable(state, "missing")).resolves.toEqual({
      ok: false,
      error: "session not found",
      code: "NOT_FOUND",
    });
  });
});
