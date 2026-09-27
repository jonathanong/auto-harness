import { beforeEach, expect, it } from "vitest";
import { createDynamoTestCtx } from "../test-helpers/dynamo-test-helpers.ts";
import { blackboardServer } from "../test-helpers/blackboard-server.ts";
import { config, session } from "../test-helpers/blackboard-reporting-fixtures.ts";
import { createBlackboardReporting } from "./blackboard-reporting.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
const ctx = createDynamoTestCtx("BbCommandFence");
beforeEach(async () => {
  await ctx.storage!.clearAll();
});
const message = {
  type: "session:command-start" as const,
  sessionId: "session",
  worktreeId: "worktree",
  attemptId: "attempt",
};

it("cannot acknowledge a delayed online probe after a concurrent connection/assignment replacement", async () => {
  const server = await blackboardServer();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const reporting = createBlackboardReporting(config(server.url), {
      dependencies: {
        loadClient: async () => {
          entered.resolve();
          await release.promise;
          return import("agent-blackboard");
        },
      },
    });
    const state = createControlPlaneState({ blackboardReporting: reporting });
    state.storage = ctx.storage!;
    await ctx.storage!.putSession(session({ assignmentConnectionId: "old" }));
    expect(
      await ctx.storage!.tryAcquireHostLock({
        hostId: "host",
        connectionId: "old",
        replaceExisting: true,
      }),
    ).toBe(true);
    const pending = handleHostMessageDurable(state, message, "old");
    await entered.promise;
    expect(
      await ctx.storage!.tryAcquireHostLock({
        hostId: "host",
        connectionId: "new",
        replaceExisting: true,
      }),
    ).toBe(true);
    await ctx.storage!.putSession(session({ assignmentConnectionId: "new" }));
    release.resolve();
    expect(await pending).not.toHaveProperty("sessionCommandStartAcknowledged");
    expect(await ctx.storage!.getSession("session", true)).toMatchObject({
      primaryCommandStartState: "pending",
    });
    expect(await handleHostMessageDurable(state, message, "new")).toHaveProperty(
      "sessionCommandStartAcknowledged",
    );
    const proof = await ctx.storage!.getSession("session", true);
    expect(proof).toMatchObject({
      assignmentConnectionId: "new",
      primaryCommandStartState: "authorized",
      reportingAdmissionAttemptId: "attempt",
    });
    // Exact current replay reuses the execution grant, not a new Blackboard admission.
    const count = server.entries.get("session")!.length;
    expect(await handleHostMessageDurable(state, message, "new")).toHaveProperty(
      "sessionCommandStartAcknowledged",
    );
    expect(server.entries.get("session")).toHaveLength(count);
    expect(
      await handleHostMessageDurable(state, { ...message, attemptId: "stale" }, "new"),
    ).not.toHaveProperty("sessionCommandStartAcknowledged");
  } finally {
    release.resolve();
    await server.close();
  }
});

it("does not treat a new current host connection as an exact replay of an old persisted assignment", async () => {
  const server = await blackboardServer();
  try {
    const state = createControlPlaneState({
      blackboardReporting: createBlackboardReporting(config(server.url)),
    });
    state.storage = ctx.storage!;
    await ctx.storage!.putSession(
      session({
        assignmentConnectionId: "old",
        primaryCommandStartState: "authorized",
        reportingAdmissionAttemptId: "attempt",
      }),
    );
    expect(
      await ctx.storage!.tryAcquireHostLock({
        hostId: "host",
        connectionId: "new",
        replaceExisting: true,
      }),
    ).toBe(true);
    expect(await handleHostMessageDurable(state, message, "new")).not.toHaveProperty(
      "sessionCommandStartAcknowledged",
    );
    expect(server.entries.size).toBe(0);
    await ctx.storage!.putSession(
      session({
        hostId: "other-host",
        assignmentConnectionId: "new",
        primaryCommandStartState: "pending",
      }),
    );
    // The host-lock/session-host conditions apply on the initial grant as well as replay.
    expect(
      await ctx.storage!.authorizePrimaryCommandStart({
        sessionId: "session",
        worktreeId: "worktree",
        attemptId: "attempt",
        fence: { hostId: "host", connectionId: "new" },
      }),
    ).toBe(false);
  } finally {
    await server.close();
  }
});

it("cannot authorize when a disconnect commits during the fresh online probe", async () => {
  const server = await blackboardServer();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const reporting = createBlackboardReporting(config(server.url), {
      dependencies: {
        loadClient: async () => {
          entered.resolve();
          await release.promise;
          return import("agent-blackboard");
        },
      },
    });
    const state = createControlPlaneState({ blackboardReporting: reporting });
    state.storage = ctx.storage!;
    await ctx.storage!.putSession(session({ assignmentConnectionId: "connection" }));
    expect(
      await ctx.storage!.tryAcquireHostLock({
        hostId: "host",
        connectionId: "connection",
        replaceExisting: true,
      }),
    ).toBe(true);
    const pending = handleHostMessageDurable(state, message, "connection");
    await entered.promise;
    expect(await ctx.storage!.releaseHostConnection("host", "connection")).toBe(true);
    release.resolve();
    expect(await pending).not.toHaveProperty("sessionCommandStartAcknowledged");
    expect(await ctx.storage!.getSession("session", true)).toMatchObject({
      primaryCommandStartState: "pending",
    });
  } finally {
    release.resolve();
    await server.close();
  }
});
