import { describe, expect, it } from "vitest";

import { createControlPlane } from "./create-plane.ts";
import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";
import type { SessionRecord } from "./db/types.ts";

const ctx = createDynamoTestCtx("SchedRecover");
const NOW = "2026-01-01T00:00:00.000Z";

async function setup(suffix: string) {
  const commandId = `command-${suffix}`;
  const connectionId = `connection-${suffix}`;
  const hostId = `host-${suffix}`;
  const repositoryId = `repository-${suffix}`;
  const sessionId = `session-${suffix}`;
  await ctx.storage!.putCommand({
    id: commandId,
    name: commandId,
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const created = await createControlPlane({
    tablePrefix: ctx.prefix,
    skipEnsureTables: true,
    shardCount: 1,
    ackDeadlineMs: 10,
    now: () => NOW,
    connectionIdFactory: () => connectionId,
  });
  expect(
    await created.plane.registerHostDurable({
      hostId,
      worktrees: [],
      commandProfiles: [],
      capabilities: ["scheduled-main-checkout"],
      repositories: [{ id: repositoryId, path: `/repo-${suffix}`, defaultBranch: "main" }],
      replaceExisting: true,
    }),
  ).toMatchObject({ ok: true });
  const session: SessionRecord = {
    id: sessionId,
    repositoryId,
    prompt: suffix,
    target: { commandId },
    fallbacks: [],
    targetLabels: [commandId],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "queued",
    queueShard: 0,
    createdAt: NOW,
    retryCount: 0,
    type: "scheduled",
    source: "schedule",
  };
  await ctx.storage!.putSession(session);
  await created.plane.hydrateFromStorage();
  expect(
    (await created.plane.assignScheduledQueuedDurable()).some(
      (assignment) => assignment.session.id === sessionId,
    ),
  ).toBe(true);
  return { ...created, commandId, connectionId, hostId, repositoryId, sessionId };
}

function expectAssignmentCleared(session: SessionRecord | null) {
  expect(session).toMatchObject({ status: "queued", hostId: null, worktreeId: null });
  for (const field of [
    "mainCheckoutLease",
    "assignmentConnectionId",
    "assignmentSentAt",
    "startedAt",
    "ackReceivedAt",
    "reconnectDeadlineAt",
  ]) {
    expect(session).not.toHaveProperty(field);
  }
}

describe("durable scheduled recovery", () => {
  it("rebuilds the ACK deadline after restart and releases the durable lease", async () => {
    if (!ctx.available || !ctx.storage) return expect(true).toBe(true);
    const seeded = await setup("restart");
    const fresh = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      shardCount: 1,
      ackDeadlineMs: 10,
    });
    fresh.plane.state.pendingAcks.set(seeded.sessionId, {
      sessionId: seeded.sessionId,
      worktreeId: null,
      assignedAtMs: 0,
    });
    await fresh.plane.hydrateFromStorage();
    expect(fresh.plane.state.pendingAcks.size).toBe(0);
    expect(fresh.plane.state.mainCheckoutLeases.size).toBe(1);
    expect(await fresh.plane.enforceAckDeadlinesDurable(Date.parse(NOW) + 10)).toEqual([
      seeded.sessionId,
    ]);
    expectAssignmentCleared(await ctx.storage.getSession(seeded.sessionId));
    expectAssignmentCleared(fresh.plane.state.sessions.get(seeded.sessionId) ?? null);
    expect(await ctx.storage.getMainCheckoutLease(seeded.hostId, seeded.repositoryId)).toBeNull();
  });

  it("uses durable rows when a stale process handles an unacked disconnect", async () => {
    if (!ctx.available || !ctx.storage) return expect(true).toBe(true);
    const seeded = await setup("disconnect");
    const stale = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      shardCount: 1,
    });
    await stale.plane.hydrateFromStorage();
    stale.plane.state.sessions.clear();
    expect(await stale.plane.disconnectHostDurable(seeded.connectionId)).toEqual([
      seeded.sessionId,
    ]);
    expectAssignmentCleared(await ctx.storage.getSession(seeded.sessionId));
  });

  it("requeues an acknowledged run omitted by a fresh replacement", async () => {
    if (!ctx.available || !ctx.storage) return expect(true).toBe(true);
    const seeded = await setup("omitted");
    const attemptId = seeded.plane.getSession(seeded.sessionId)?.attemptId;
    if (!attemptId) throw new Error("missing scheduled attempt");
    expect(
      await seeded.plane.handleHostMessageDurable(
        { type: "session:ack", sessionId: seeded.sessionId, worktreeId: null, attemptId },
        seeded.connectionId,
      ),
    ).toMatchObject({ sessionAcknowledged: seeded.sessionId });
    const replacement = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      shardCount: 1,
      connectionIdFactory: () => "connection-omitted-new",
    });
    await replacement.plane.hydrateFromStorage();
    expect(
      await replacement.plane.registerHostDurable({
        hostId: seeded.hostId,
        worktrees: [],
        commandProfiles: [],
        capabilities: ["scheduled-main-checkout"],
        repositories: [{ id: seeded.repositoryId, path: "/repo-omitted", defaultBranch: "main" }],
        runningSessions: [],
        replaceExisting: true,
      }),
    ).toMatchObject({ ok: true });
    expectAssignmentCleared(await ctx.storage.getSession(seeded.sessionId));
  });

  it("persists late cancellation metadata and clears the assignment fence", async () => {
    if (!ctx.available || !ctx.storage) return expect(true).toBe(true);
    const seeded = await setup("cancelled");
    const attemptId = seeded.plane.getSession(seeded.sessionId)?.attemptId;
    if (!attemptId) throw new Error("missing scheduled attempt");
    seeded.plane.cancelSession(seeded.sessionId);
    await seeded.plane.settleStorage();
    await seeded.plane.handleHostMessageDurable(
      {
        type: "session:status",
        sessionId: seeded.sessionId,
        worktreeId: null,
        attemptId,
        status: "cancelled",
        exitCode: 130,
        errorCode: "cancelled_by_user",
        errorMessage: "stopped",
        cliResumeRef: "resume-cancelled",
      },
      seeded.connectionId,
    );
    const persisted = await ctx.storage.getSession(seeded.sessionId);
    expect(persisted).toMatchObject({
      status: "cancelled",
      exitCode: 130,
      errorCode: "cancelled_by_user",
      errorMessage: "stopped",
      cliResumeRef: "resume-cancelled",
    });
    for (const field of ["mainCheckoutLease", "assignmentConnectionId", "assignmentSentAt"]) {
      expect(persisted).not.toHaveProperty(field);
      expect(seeded.plane.state.sessions.get(seeded.sessionId)).not.toHaveProperty(field);
    }
  });
});
