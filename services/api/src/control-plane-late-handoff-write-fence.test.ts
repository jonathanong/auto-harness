import { expect, it, vi } from "vitest";

import { setDurableReadStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function terminalSession(kind: "detached" | "worktree" | "workspace" | "main"): SessionRecord {
  return {
    id: "session",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: [],
    queueTtlSeconds: 60,
    queueExpiresAt: "later",
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: kind === "detached" ? "timed_out" : "cancelled",
    queueShard: 0,
    createdAt: NOW,
    completedAt: NOW,
    attemptId: "attempt",
    hostId: kind === "detached" ? null : "host",
    worktreeId: kind === "worktree" ? "worktree" : null,
    ...(kind === "detached" ? { timedOutHostId: "host" } : {}),
    ...(kind === "workspace" ? { workspaceSlotId: "slot" } : {}),
    ...(kind === "main"
      ? { mainCheckoutLease: true as const, assignmentConnectionId: "connection" }
      : {}),
  };
}

const deferredStatus = {
  type: "session:status" as const,
  sessionId: "session",
  attemptId: "attempt",
  status: "failed" as const,
  errorCode: "checkout_fetch_failed" as const,
  deferTerminalHookResult: true as const,
};

for (const kind of ["detached", "worktree", "workspace", "main"] as const) {
  it(`withholds a ${kind} handoff acknowledgement when its conditional write loses`, async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const current = terminalSession(kind);
    const finishSession = vi.fn(async () => false);
    const releaseMainCheckoutSession = vi.fn(async () => false);
    setDurableReadStorage(state, { finishSession, releaseMainCheckoutSession });
    state.sessions.set(current.id, current);

    await expect(
      handleHostMessageDurable(
        state,
        { ...deferredStatus, worktreeId: current.worktreeId ?? null },
        undefined,
        false,
        false,
        7,
      ),
    ).resolves.toEqual({ ok: true });
    expect(kind === "main" ? releaseMainCheckoutSession : finishSession).toHaveBeenCalledOnce();
  });

  it(`withholds a ${kind} handoff acknowledgement until strong read confirms ownership`, async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const current = terminalSession(kind);
    const finishSession = vi.fn(async () => true);
    const releaseMainCheckoutSession = vi.fn(async () => true);
    setDurableReadStorage(state, {
      getSession: async () => current,
      finishSession,
      releaseMainCheckoutSession,
    });
    state.sessions.set(current.id, current);

    await expect(
      handleHostMessageDurable(
        state,
        { ...deferredStatus, worktreeId: current.worktreeId ?? null },
        undefined,
        false,
        false,
        7,
      ),
    ).resolves.toEqual({ ok: true });
    expect(kind === "main" ? releaseMainCheckoutSession : finishSession).toHaveBeenCalledOnce();
  });
}

it("retains account and host lease cleanup with late handoffs across resource kinds", async () => {
  for (const kind of ["detached", "worktree", "workspace", "main"] as const) {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => kind });
    const current: SessionRecord = {
      ...terminalSession(kind),
      concurrencyId: "run-lock",
      providerAccountLease: {
        concurrencyId: "account-lock",
        providerAccountId: "account",
        slot: 0,
        attemptId: "attempt",
      },
      hostAssignmentLease: { hostId: "host" },
    };
    let persisted = current;
    const finishSession = vi.fn(
      async (opts: { terminalHookHandoff?: SessionRecord["terminalHookHandoff"] }) => {
        persisted = { ...current, terminalHookHandoff: opts.terminalHookHandoff };
        return true;
      },
    );
    const releaseMainCheckoutSession = vi.fn(finishSession);
    setDurableReadStorage(state, {
      getSession: async () => persisted,
      finishSession,
      releaseMainCheckoutSession,
    });
    state.sessions.set(current.id, current);

    await expect(
      handleHostMessageDurable(
        state,
        { ...deferredStatus, worktreeId: current.worktreeId ?? null },
        undefined,
        false,
        false,
        7,
      ),
    ).resolves.toMatchObject({ sessionStatusAcknowledged: { terminalHookHandoffId: kind } });
    const write = kind === "main" ? releaseMainCheckoutSession : finishSession;
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAccountLease: current.providerAccountLease,
        hostAssignmentLease: current.hostAssignmentLease,
        ...(kind === "detached" ? {} : { concurrencyId: "run-lock" }),
      }),
    );
    if (kind === "detached") {
      expect(write).toHaveBeenCalledWith(
        expect.not.objectContaining({ concurrencyId: "run-lock" }),
      );
    }
  }
});
