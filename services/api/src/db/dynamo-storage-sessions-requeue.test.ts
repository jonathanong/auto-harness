/* eslint-disable max-lines */
import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { queueOrderKey } from "../control-plane-ordering.ts";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import {
  releaseHostConnection,
  tryAcquireHostLock,
  tryRegisterHost,
} from "./plane-storage-locks.ts";
import {
  acknowledgeSession,
  getSession,
  getWorktree,
  putSession,
  putWorktree,
  tryRequeueSession,
} from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let tables: DynamoTableNames;
let ctx: PlaneStorageCtx;
const base = {
  repositoryId: "repo",
  prompt: "prompt",
  target: { commandId: "command" },
  fallbacks: [],
  targetDisplayNames: ["command"],
  queueTtlSeconds: 60,
  queueExpiresAt: "2026-01-01T01:00:00.000Z",
  timeout: 60,
  priority: 0,
  requiredLabels: [],
  queueShard: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
};

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhD35Requeue${process.pid}` });
  ctx = { doc: clients.doc, tables };
});
afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local requeue and acknowledgement races", () => {
  it("requeues after a retained disconnected host lock but fences a replacement registration", async () => {
    const hostId = "reconnect-host";
    await tryAcquireHostLock(ctx, {
      hostId,
      connectionId: "disconnected-connection",
      replaceExisting: false,
    });
    expect(
      await releaseHostConnection(ctx, {
        hostId,
        connectionId: "disconnected-connection",
      }),
    ).toBe(true);
    expect(
      (await ctx.doc.send(new GetCommand({ TableName: tables.hostLocks, Key: { hostId } }))).Item,
    ).toMatchObject({
      hostId,
      connectionId: "disconnected-connection",
      disconnected: true,
    });

    await putSession(ctx, {
      ...base,
      id: "retained-disconnected-lock",
      status: "running",
      worktreeId: "retained-disconnected-worktree",
      hostId,
      attemptId: "attempt",
    });
    await putWorktree(ctx, {
      id: "retained-disconnected-worktree",
      name: "retained-disconnected-worktree",
      hostId,
      repositoryId: "repo",
      path: "/repo",
      labels: [],
      status: "busy",
      online: false,
      currentSessionId: "retained-disconnected-lock",
    });
    expect(
      await tryRequeueSession(ctx, {
        sessionId: "retained-disconnected-lock",
        worktreeId: "retained-disconnected-worktree",
        attemptId: "attempt",
        queueShard: 0,
        requireNoHostLock: hostId,
      }),
    ).toBe(true);

    await putSession(ctx, {
      ...base,
      id: "replacement-fenced-lock",
      status: "running",
      worktreeId: "replacement-fenced-worktree",
      hostId,
      attemptId: "attempt",
    });
    await putWorktree(ctx, {
      id: "replacement-fenced-worktree",
      name: "replacement-fenced-worktree",
      hostId,
      repositoryId: "repo",
      path: "/repo",
      labels: [],
      status: "busy",
      online: false,
      currentSessionId: "replacement-fenced-lock",
    });
    expect(
      await tryRegisterHost(ctx, {
        hostId,
        connection: {
          connectionId: "replacement-connection",
          type: "host",
          hostId,
          connectedAt: base.createdAt,
          lastHeartbeatAt: base.createdAt,
          commandProfiles: [],
        },
        replaceExisting: false,
      }),
    ).toBe(true);
    expect(
      await tryRequeueSession(ctx, {
        sessionId: "replacement-fenced-lock",
        worktreeId: "replacement-fenced-worktree",
        attemptId: "attempt",
        queueShard: 0,
        requireNoHostLock: hostId,
      }),
    ).toBe(false);
    expect((await getSession(ctx, "replacement-fenced-lock"))?.status).toBe("running");
  });

  it("requeues only the exact running attempt and can fence a reconnect", async () => {
    await putSession(ctx, {
      ...base,
      id: "run",
      status: "running",
      worktreeId: "wt",
      hostId: "host",
      attemptId: "attempt",
      assignmentConnectionId: "connection",
      reconnectDeadlineAt: "deadline",
    });
    await putWorktree(ctx, {
      id: "wt",
      name: "wt",
      hostId: "host",
      repositoryId: "repo",
      path: "/repo",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "run",
      connectionId: "connection",
    });
    expect(
      await tryRequeueSession(ctx, {
        sessionId: "run",
        worktreeId: "wt",
        attemptId: "wrong",
        queueShard: 0,
      }),
    ).toBe(false);
    expect(
      await tryRequeueSession(ctx, {
        sessionId: "run",
        worktreeId: "wt",
        attemptId: "attempt",
        queueShard: 0,
        reason: "reconnect",
        forceOffline: true,
        expectedHostId: "host",
        expectedReconnectDeadlineAt: "deadline",
        expectedConnectionId: "connection",
        nextConnectionId: "next",
        requireUnacknowledged: true,
      }),
    ).toBe(true);
    expect((await getSession(ctx, "run"))?.status).toBe("queued");
    expect(
      (await ctx.doc.send(new GetCommand({ TableName: tables.sessions, Key: { id: "run" } }))).Item
        ?.queueOrder,
    ).toBe(queueOrderKey({ id: "run", priority: base.priority, createdAt: base.createdAt }));
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.sessions,
        Item: {
          ...base,
          id: "legacy-run",
          status: "running",
          statusShard: "running#0",
          worktreeId: "legacy-wt",
          hostId: "host",
          attemptId: "attempt",
        },
      }),
    );
    await putWorktree(ctx, {
      id: "legacy-wt",
      name: "legacy",
      hostId: "host",
      repositoryId: "repo",
      path: "/repo",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "legacy-run",
    });
    expect(
      await tryRequeueSession(ctx, {
        sessionId: "legacy-run",
        worktreeId: "legacy-wt",
        attemptId: "attempt",
        queueShard: 0,
      }),
    ).toBe(true);
    expect(
      (
        await ctx.doc.send(
          new GetCommand({ TableName: tables.sessions, Key: { id: "legacy-run" } }),
        )
      ).Item?.queueOrder,
    ).toBe(
      queueOrderKey({
        id: "legacy-run",
        priority: base.priority,
        createdAt: base.createdAt,
      }),
    );
    expect((await getWorktree(ctx, "wt"))?.online).toBe(false);
    await putSession(ctx, {
      ...base,
      id: "fenced",
      status: "running",
      worktreeId: "fenced-wt",
      hostId: "fenced-host",
      attemptId: "attempt",
    });
    await putWorktree(ctx, {
      id: "fenced-wt",
      name: "fenced",
      hostId: "fenced-host",
      repositoryId: "repo",
      path: "/repo",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "fenced",
    });
    expect(
      await tryRequeueSession(ctx, {
        sessionId: "fenced",
        worktreeId: "fenced-wt",
        attemptId: "attempt",
        queueShard: 0,
        fence: { hostId: "fenced-host", connectionId: "missing" },
        requireNoHostLock: "free-host",
      }),
    ).toBe(false);
    await expect(
      tryRequeueSession(
        { ...ctx, tables: { ...tables, sessions: "missing-sessions" } },
        { sessionId: "fenced", worktreeId: "fenced-wt", attemptId: "attempt", queueShard: 0 },
      ),
    ).rejects.toThrow();
  });

  it("acknowledges an exact attempt, accepts its duplicate, and rejects a stale lease", async () => {
    await putSession(ctx, {
      ...base,
      id: "ack",
      status: "running",
      worktreeId: "ack-wt",
      hostId: "ack-host",
      attemptId: "attempt",
      assignmentConnectionId: "connection",
      assignmentSentAt: "sent",
    });
    expect(
      await tryAcquireHostLock(ctx, {
        hostId: "ack-host",
        connectionId: "connection",
        replaceExisting: false,
      }),
    ).toBe(true);
    expect(
      await acknowledgeSession(ctx, {
        sessionId: "ack",
        worktreeId: "ack-wt",
        attemptId: "attempt",
        acknowledgedAt: "ack",
        fence: { hostId: "ack-host", connectionId: "connection" },
      }),
    ).toBe(true);
    expect(
      await acknowledgeSession(ctx, {
        sessionId: "ack",
        worktreeId: "ack-wt",
        attemptId: "attempt",
        acknowledgedAt: "again",
        fence: { hostId: "ack-host", connectionId: "connection" },
      }),
    ).toBe(true);
    expect(
      await acknowledgeSession(ctx, "ack", "again", {
        hostId: "ack-host",
        connectionId: "connection",
      }),
    ).toBe(true);
    expect(
      await acknowledgeSession(ctx, "ack", "again", { hostId: "ack-host", connectionId: "wrong" }),
    ).toBe(false);
    await putSession(ctx, { ...base, id: "legacy", status: "running" });
    expect(await acknowledgeSession(ctx, "legacy", "ack")).toBe(true);
    expect(await acknowledgeSession(ctx, "legacy", "again")).toBe(true);
    expect(await acknowledgeSession(ctx, "missing", "ack")).toBe(true);
    await putSession(ctx, {
      ...base,
      id: "modern",
      status: "running",
      worktreeId: "modern-wt",
      attemptId: "attempt",
      assignmentSentAt: "sent",
    });
    expect(
      await acknowledgeSession(ctx, {
        sessionId: "modern",
        worktreeId: "modern-wt",
        attemptId: "attempt",
        acknowledgedAt: "ack",
      }),
    ).toBe(true);
  });

  it("retries infrastructure failures once, requiring a pending command-start for host loss", async () => {
    const seed = async (
      id: string,
      primaryCommandStartState: "pending" | "authorized",
      infrastructureRetryCount?: number,
    ) => {
      const worktreeId = `${id}-worktree`;
      await putSession(ctx, {
        ...base,
        id,
        status: "running",
        hostId: "host",
        worktreeId,
        attemptId: "attempt",
        primaryCommandStartState,
        ...(infrastructureRetryCount === undefined ? {} : { infrastructureRetryCount }),
      });
      await putWorktree(ctx, {
        id: worktreeId,
        name: worktreeId,
        hostId: "host",
        repositoryId: "repo",
        path: `/${worktreeId}`,
        labels: [],
        status: "busy",
        online: true,
        currentSessionId: id,
      });
      return worktreeId;
    };
    const requeue = (
      sessionId: string,
      worktreeId: string,
      infrastructureErrorCode: "checkout_fetch_failed" | "host_lost",
    ) =>
      tryRequeueSession(ctx, {
        sessionId,
        worktreeId,
        attemptId: "attempt",
        queueShard: 0,
        infrastructureErrorCode,
      });

    const pendingWorktree = await seed("pending-host-loss", "pending");
    expect(await requeue("pending-host-loss", pendingWorktree, "host_lost")).toBe(true);
    expect(await getSession(ctx, "pending-host-loss")).toMatchObject({
      status: "queued",
      infrastructureRetryCount: 1,
      lastInfrastructureErrorCode: "host_lost",
    });
    expect(await getSession(ctx, "pending-host-loss")).not.toHaveProperty(
      "primaryCommandStartState",
    );

    const authorizedWorktree = await seed("authorized-host-loss", "authorized");
    expect(await requeue("authorized-host-loss", authorizedWorktree, "host_lost")).toBe(false);
    expect((await getSession(ctx, "authorized-host-loss"))?.status).toBe("running");
    expect(await requeue("authorized-host-loss", authorizedWorktree, "checkout_fetch_failed")).toBe(
      true,
    );
    expect(await getSession(ctx, "authorized-host-loss")).toMatchObject({
      status: "queued",
      infrastructureRetryCount: 1,
      lastInfrastructureErrorCode: "checkout_fetch_failed",
    });

    const cappedWorktree = await seed("capped-infrastructure-retry", "pending", 1);
    expect(
      await requeue("capped-infrastructure-retry", cappedWorktree, "checkout_fetch_failed"),
    ).toBe(false);
    expect(await requeue("capped-infrastructure-retry", cappedWorktree, "host_lost")).toBe(false);
    expect(await getSession(ctx, "capped-infrastructure-retry")).toMatchObject({
      status: "running",
      infrastructureRetryCount: 1,
    });
  });
});
