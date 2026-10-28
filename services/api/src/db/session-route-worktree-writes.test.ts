import { describe, expect, it, vi } from "vitest";

import { tryAssignMainCheckoutSession } from "./plane-storage-main-checkout.ts";
import { tryAssignSession } from "./plane-storage-sessions-assign.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import { tryAssignWorkspaceSession } from "./plane-storage-workspaces.ts";
import type { SessionRecord } from "./types.ts";

type SessionUpdate = {
  UpdateExpression: string;
  ExpressionAttributeValues: Record<string, unknown>;
};

const tables = new Proxy({}, { get: (_target, name) => String(name) });

/** Run a write against a recording fake and return its Sessions UpdateItem. */
async function sessionUpdate(
  write: (ctx: PlaneStorageCtx) => Promise<unknown>,
): Promise<SessionUpdate> {
  const send = vi.fn().mockResolvedValue({});
  await write({ doc: { send } as never, tables: tables as never });
  const items = send.mock.calls[0]![0].input.TransactItems as Array<{
    Update?: { TableName: string } & SessionUpdate;
  }>;
  return items.find((item) => item.Update?.TableName === "sessions")!.Update!;
}

function route(worktreeId: string | null): SessionRecord["resolvedRoute"] {
  return { targetIndex: 0, commandId: "cmd", hostId: "host", worktreeId, attemptId: "attempt" };
}

const common = {
  sessionId: "session",
  repositoryId: "repo",
  hostId: "host",
  hostInventoryVersion: null,
  connectionId: "connection",
  now: "2026-01-01T00:00:00.000Z",
  attemptId: "attempt",
  resolvedArgv: ["echo"],
  queueShard: 0,
};

describe("routeWorktreeId follows every resolvedRoute write", () => {
  it("sets it when a worktree session is assigned", async () => {
    const update = await sessionUpdate((ctx) =>
      tryAssignSession(ctx, { ...common, worktreeId: "wt-1", resolvedRoute: route("wt-1") }),
    );
    expect(update.UpdateExpression).toContain("routeWorktreeId = :routeWorktreeId");
    expect(update.UpdateExpression).not.toMatch(/REMOVE .*routeWorktreeId/u);
    expect(update.ExpressionAttributeValues[":routeWorktreeId"]).toBe("wt-1");
  });

  it("removes it when a worktree-less route is assigned over a previous one", async () => {
    const update = await sessionUpdate((ctx) =>
      tryAssignSession(ctx, { ...common, worktreeId: "wt-1", resolvedRoute: route(null) }),
    );
    expect(update.UpdateExpression).toMatch(/REMOVE .*, routeWorktreeId$/u);
    expect(update.UpdateExpression).not.toContain(":routeWorktreeId");
    expect(update.ExpressionAttributeValues).not.toHaveProperty(":routeWorktreeId");
  });

  it("removes it for workspace slots, which have no worktree", async () => {
    const update = await sessionUpdate((ctx) =>
      tryAssignWorkspaceSession(ctx, {
        ...common,
        workspacePoolId: "pool",
        workspaceSlotId: "slot",
        resolvedRoute: route(null),
      }),
    );
    expect(update.UpdateExpression).toMatch(/REMOVE .*, routeWorktreeId$/u);
    expect(update.ExpressionAttributeValues).not.toHaveProperty(":routeWorktreeId");
  });

  it("sets it when a workspace route names a worktree", async () => {
    const update = await sessionUpdate((ctx) =>
      tryAssignWorkspaceSession(ctx, {
        ...common,
        workspacePoolId: "pool",
        workspaceSlotId: "slot",
        resolvedRoute: route("wt-2"),
      }),
    );
    expect(update.UpdateExpression).toContain("routeWorktreeId = :routeWorktreeId");
    expect(update.ExpressionAttributeValues[":routeWorktreeId"]).toBe("wt-2");
  });

  it.each([
    ["removes it for a main-checkout route", route(null), false],
    ["sets it when the route names a worktree", route("wt-3"), true],
  ])("%s", async (_label, resolvedRoute, set) => {
    const update = await sessionUpdate((ctx) =>
      tryAssignMainCheckoutSession(ctx, { ...common, resolvedRoute }),
    );
    if (set) {
      expect(update.UpdateExpression).toContain(", routeWorktreeId = :routeWorktreeId");
      expect(update.ExpressionAttributeValues[":routeWorktreeId"]).toBe("wt-3");
    } else {
      expect(update.UpdateExpression).toMatch(/REMOVE .*, routeWorktreeId$/u);
      expect(update.ExpressionAttributeValues).not.toHaveProperty(":routeWorktreeId");
    }
  });
});
