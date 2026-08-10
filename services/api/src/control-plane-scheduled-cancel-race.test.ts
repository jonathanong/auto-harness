import { describe, expect, it } from "vitest";

import { createControlPlane } from "./create-plane.ts";
import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("ScheduledCancelRace");
const NOW = "2026-01-01T00:00:00.000Z";
const HOST_ID = "cancel-race-host";
const REPOSITORY_ID = "cancel-race-repo";
const COMMAND_ID = "cancel-race-command";

async function registeredPlane(connectionId: string) {
  const created = await createControlPlane({
    tablePrefix: ctx.prefix,
    skipEnsureTables: true,
    connectionIdFactory: () => connectionId,
    attemptIdFactory: (() => {
      let sequence = 0;
      return () => `${connectionId}-attempt-${++sequence}`;
    })(),
    now: () => NOW,
    shardCount: 1,
  });
  created.plane.createCommand({
    id: COMMAND_ID,
    name: "cancel race",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
  });
  await created.plane.settleStorage();
  const registration = await created.plane.registerHostDurable({
    hostId: HOST_ID,
    worktrees: [],
    repositories: [{ id: REPOSITORY_ID, path: "/repo", defaultBranch: "main" }],
    commandProfiles: [],
    capabilities: ["scheduled-main-checkout"],
    replaceExisting: true,
  });
  expect(registration).toMatchObject({ ok: true });
  return { ...created, connectionId };
}

describe("durable scheduled cancellation races", () => {
  it("reclaims an exact cancelled attempt after disconnect and restart", async () => {
    if (!ctx.available || !ctx.storage) return;
    const run = await registeredPlane("cancel-exact");
    const outbound: unknown[] = [];
    run.plane.state.onHostMessage = (_hostId, message) => outbound.push(message);
    const created = await run.plane.createSessionDurable({
      repositoryId: REPOSITORY_ID,
      prompt: "scheduled run",
      target: { commandId: COMMAND_ID },
      timeout: 30,
      type: "scheduled",
      source: "schedule",
      concurrencyId: "cancel-exact-lock",
    });
    if (!created.ok) throw new Error(created.error);
    expect(await run.plane.assignScheduledQueuedDurable()).toHaveLength(1);
    const assigned = run.plane.getSession(created.session.id)!;
    await run.plane.handleHostMessageDurable(
      {
        type: "session:ack",
        sessionId: assigned.id,
        worktreeId: null,
        attemptId: assigned.attemptId!,
      },
      run.connectionId,
    );

    await expect(run.plane.cancelSessionDurable(assigned.id)).resolves.toMatchObject({
      ok: true,
      session: { status: "cancelled" },
    });
    expect(outbound).toContainEqual({ type: "session:cancel", sessionId: assigned.id });
    expect(await ctx.storage.getMainCheckoutLease(HOST_ID, REPOSITORY_ID)).toMatchObject({
      sessionId: assigned.id,
      connectionId: run.connectionId,
    });

    expect(await run.plane.disconnectHostDurable(run.connectionId)).toEqual([]);
    const restarted = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      now: () => NOW,
      shardCount: 1,
    });
    await restarted.plane.hydrateFromStorage();
    const deadline = Date.parse(NOW) + run.plane.state.reconnectGraceMs;
    expect(await restarted.plane.reclaimReconnectDeadlines(deadline - 1)).toEqual([]);
    expect(await ctx.storage.getMainCheckoutLease(HOST_ID, REPOSITORY_ID)).toBeTruthy();
    expect(await restarted.plane.reclaimReconnectDeadlines(deadline)).toEqual([]);
    expect(await ctx.storage.getMainCheckoutLease(HOST_ID, REPOSITORY_ID)).toBeNull();
    expect(restarted.plane.state.mainCheckoutLeases.size).toBe(0);
    expect(
      await restarted.plane.registerHostDurable({
        hostId: HOST_ID,
        worktrees: [],
        repositories: [{ id: REPOSITORY_ID, path: "/repo", defaultBranch: "main" }],
        commandProfiles: [],
        capabilities: ["scheduled-main-checkout"],
        replaceExisting: true,
      }),
    ).toMatchObject({ ok: true });
    const next = await restarted.plane.createSessionDurable({
      repositoryId: REPOSITORY_ID,
      prompt: "next scheduled run",
      target: { commandId: COMMAND_ID },
      timeout: 30,
      type: "scheduled",
      source: "schedule",
      concurrencyId: "cancel-exact-lock",
    });
    expect(next).toMatchObject({ ok: true, created: true });
    expect(await restarted.plane.assignScheduledQueuedDurable()).toHaveLength(1);
    if (!next.ok) throw new Error(next.error);
    const followOn = restarted.plane.state.sessions.get(next.session.id)!;
    await restarted.plane.handleHostMessageDurable(
      {
        type: "session:status",
        sessionId: followOn.id,
        worktreeId: null,
        attemptId: followOn.attemptId!,
        status: "completed",
      },
      followOn.assignmentConnectionId!,
    );
  });

  it("fences a stale cancel from overwriting a reassigned attempt", async () => {
    if (!ctx.available || !ctx.storage) return;
    const stale = await registeredPlane("cancel-race-old");
    const created = await stale.plane.createSessionDurable({
      repositoryId: REPOSITORY_ID,
      prompt: "scheduled run",
      target: { commandId: COMMAND_ID },
      timeout: 30,
      type: "scheduled",
      source: "schedule",
      concurrencyId: "cancel-race-lock",
    });
    if (!created.ok) throw new Error(created.error);
    expect(await stale.plane.assignScheduledQueuedDurable()).toHaveLength(1);
    const first = stale.plane.state.sessions.get(created.session.id)!;
    await stale.plane.handleHostMessageDurable(
      {
        type: "session:ack",
        sessionId: first.id,
        worktreeId: null,
        attemptId: first.attemptId!,
      },
      stale.connectionId,
    );

    const replacement = await registeredPlane("cancel-race-new");
    await replacement.plane.hydrateFromStorage();
    expect(await replacement.plane.assignScheduledQueuedDurable()).toHaveLength(1);
    const second = replacement.plane.state.sessions.get(first.id)!;
    expect(second.attemptId).not.toBe(first.attemptId);

    await expect(stale.plane.cancelSessionDurable(first.id)).resolves.toEqual({
      ok: false,
      error: "session changed before cancellation",
    });
    expect(await ctx.storage.getSession(first.id)).toMatchObject({
      status: "running",
      assignmentConnectionId: replacement.connectionId,
      attemptId: second.attemptId,
    });

    await replacement.plane.handleHostMessageDurable(
      {
        type: "session:status",
        sessionId: second.id,
        worktreeId: null,
        attemptId: second.attemptId!,
        status: "completed",
      },
      replacement.connectionId,
    );
    expect(await ctx.storage.getMainCheckoutLease(HOST_ID, REPOSITORY_ID)).toBeNull();
    expect((await ctx.storage.getSession(second.id))?.status).toBe("completed");
  });
});
