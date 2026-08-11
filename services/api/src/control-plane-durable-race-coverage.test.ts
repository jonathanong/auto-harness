import { describe, expect, it } from "vitest";

import { createControlPlane } from "./create-plane.ts";
import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("RaceCoverage");
const NOW = "2026-01-01T00:00:00.000Z";
const COMMAND_ID = "race-coverage-command";
const HOST_ID = "race-coverage-host";
const REPOSITORY_ID = "race-coverage-repo";

async function plane(connectionId: string, id: string) {
  const created = await createControlPlane({
    tablePrefix: ctx.prefix,
    skipEnsureTables: true,
    now: () => NOW,
    idFactory: () => id,
    attemptIdFactory: () => `${id}-attempt`,
    connectionIdFactory: () => connectionId,
    shardCount: 1,
    ackDeadlineMs: 1,
  });
  created.plane.createCommand({
    id: COMMAND_ID,
    name: "race coverage command",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
  });
  await created.plane.settleStorage();
  const registered = await created.plane.registerHostDurable({
    hostId: HOST_ID,
    worktrees: [
      {
        id: "race-coverage-worktree",
        name: "race-coverage",
        repositoryId: REPOSITORY_ID,
        path: "/repo",
        labels: [],
      },
    ],
    commandProfiles: ["race coverage command"],
    replaceExisting: true,
  });
  if (!registered.ok) throw new Error(registered.error);
  return { ...created, connectionId };
}

async function queued(run: Awaited<ReturnType<typeof plane>>, prompt: string) {
  const created = await run.plane.createSessionDurable({
    repositoryId: REPOSITORY_ID,
    prompt,
    target: { commandId: COMMAND_ID },
    timeout: 30,
  });
  if (!created.ok) throw new Error(created.error);
  return created.session.id;
}

describe("durable prompt-session races", () => {
  it("keeps an acknowledgement that wins the deadline requeue race", async () => {
    if (!ctx.available || !ctx.storage) return;
    await ctx.storage.clearAll();
    const assigned = await plane("race-ack-connection", "race-ack-session");
    const sessionId = await queued(assigned, "ack race");
    expect(await assigned.plane.assignQueuedDurable()).toHaveLength(1);
    const attempt = assigned.plane.state.sessions.get(sessionId)!;

    const acknowledger = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      now: () => NOW,
    });
    await acknowledger.plane.hydrateFromStorage();
    await expect(
      acknowledger.plane.handleHostMessageDurable(
        {
          type: "session:ack",
          sessionId,
          worktreeId: attempt.worktreeId!,
          attemptId: attempt.attemptId!,
        },
        assigned.connectionId,
      ),
    ).resolves.toMatchObject({ ok: true, sessionAcknowledged: sessionId });

    await expect(
      assigned.plane.enforceAckDeadlinesDurable(Date.parse(NOW) + 1_000),
    ).resolves.toEqual([]);
    expect(await ctx.storage.getSession(sessionId)).toMatchObject({
      status: "running",
      ackReceivedAt: NOW,
    });
    expect((await ctx.storage.getWorktree(attempt.worktreeId!))?.status).toBe("busy");
  });

  it("clears an invalid native-resume pin before assigning the durable retry", async () => {
    if (!ctx.available || !ctx.storage) return;
    await ctx.storage.clearAll();
    const run = await plane("race-resume-connection", "race-resume-session");
    const sessionId = await queued(run, "resume after catalog edit");
    const session = run.plane.state.sessions.get(sessionId)!;
    Object.assign(session, {
      resumedFromSessionId: "prior-session",
      cliResumeRef: "opaque-ref",
      pinnedHostId: HOST_ID,
      pinnedTargetIndex: 0,
      pinnedCommandId: "deleted-command",
      resumeSpec: { argv: ["echo"], appendPrompt: true },
    });
    await ctx.storage.putSession({ ...session });
    await run.plane.hydrateFromStorage();

    await expect(run.plane.assignQueuedDurable()).resolves.toHaveLength(1);
    const stored = await ctx.storage.getSession(sessionId);
    expect(stored).toMatchObject({
      status: "running",
      resumeFallback: true,
      resolvedRoute: { commandId: COMMAND_ID },
    });
    expect(stored).not.toHaveProperty("pinnedHostId");
    expect(stored).not.toHaveProperty("cliResumeRef");
  });

  it("lets either cancellation or assignment win without a partial worktree claim", async () => {
    if (!ctx.available || !ctx.storage) return;
    await ctx.storage.clearAll();
    const assigner = await plane("race-cancel-connection", "race-cancel-session");
    const sessionId = await queued(assigner, "cancel race");
    const canceller = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      now: () => NOW,
    });
    await canceller.plane.hydrateFromStorage();

    const [assignments, cancelled] = await Promise.all([
      assigner.plane.assignQueuedDurable(),
      canceller.plane.cancelSessionDurable(sessionId),
    ]);
    const stored = await ctx.storage.getSession(sessionId);
    expect(["running", "cancelled"]).toContain(stored?.status);
    if (stored?.status === "running") {
      expect(assignments).toHaveLength(1);
      expect(cancelled).toMatchObject({ ok: false, error: "session changed before cancellation" });
    } else {
      expect(assignments).toEqual([]);
      expect(cancelled).toMatchObject({ ok: true, session: { status: "cancelled" } });
      expect((await ctx.storage.getWorktree("race-coverage-worktree"))?.status).toBe("idle");
    }
  });
});
