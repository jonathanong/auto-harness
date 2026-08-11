import { describe, expect, it } from "vitest";

import { createControlPlane } from "./create-plane.ts";
import {
  buildProviderCatalog,
  resolveScheduledSessionTarget,
} from "./control-plane-session-target.ts";
import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("ScheduledProvider");
const NOW = "2026-01-01T00:00:00.000Z";

async function plane(connectionId: string, hostId: string, repositoryId: string) {
  const created = await createControlPlane({
    tablePrefix: ctx.prefix,
    skipEnsureTables: true,
    connectionIdFactory: () => connectionId,
    idFactory: (() => {
      let id = 0;
      return () => `${hostId}-session-${++id}`;
    })(),
    now: () => NOW,
    shardCount: 1,
  });
  created.plane.createCommand({
    id: `${hostId}-command`,
    name: "scheduled command",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await created.plane.settleStorage();
  const registered = await created.plane.registerHostDurable({
    hostId,
    worktrees: [],
    repositories: [{ id: repositoryId, path: `/repos/${repositoryId}`, defaultBranch: "main" }],
    commandProfiles: [],
    capabilities: ["scheduled-main-checkout"],
    replaceExisting: true,
  });
  if (!registered.ok) throw new Error(registered.error);
  return { ...created, connectionId: registered.connectionId };
}

async function scheduled(
  controlPlane: Awaited<ReturnType<typeof plane>>["plane"],
  repositoryId: string,
  concurrencyId: string,
  target: import("@auto-harness/shared").TargetRef,
) {
  const created = await controlPlane.createSessionDurable({
    repositoryId,
    prompt: "scheduled run",
    target,
    timeout: 30,
    type: "scheduled",
    source: "schedule",
    concurrencyId,
  });
  if (!created.ok) throw new Error(created.error);
  await controlPlane.assignScheduledQueuedDurable();
  return controlPlane.getSession(created.session.id)!;
}

describe("durable scheduled terminal and provider fallback", () => {
  it("releases the matching concurrency lock for completed and late-cancelled runs", async () => {
    if (!ctx.available || !ctx.storage) return;
    const first = await plane("terminal-connection", "terminal-host", "terminal-repo");
    for (const [concurrencyId, status] of [
      ["terminal-completed", "completed"],
      ["terminal-cancelled", "cancelled"],
    ] as const) {
      const running = await scheduled(first.plane, "terminal-repo", concurrencyId, {
        commandId: "terminal-host-command",
      });
      if (status === "cancelled") first.plane.cancelSession(running.id);
      await first.plane.settleStorage();
      await first.plane.handleHostMessageDurable(
        {
          type: "session:status",
          sessionId: running.id,
          worktreeId: null,
          attemptId: running.attemptId!,
          status,
        },
        first.connectionId,
      );
      await expect(
        first.plane.createSessionDurable({
          repositoryId: "terminal-repo",
          prompt: "next trigger",
          target: { commandId: "terminal-host-command" },
          timeout: 30,
          type: "scheduled",
          source: "schedule",
          concurrencyId,
        }),
      ).resolves.toMatchObject({ ok: true, created: true });
    }
  });

  it("cools a usage-limited scheduled account then reroutes to its fallback account", async () => {
    if (!ctx.available || !ctx.storage) return;
    const run = await plane("provider-connection", "provider-host", "provider-repo");
    const provider = await run.plane.createProviderDurable({
      id: "provider",
      name: "provider",
      defaultCommandId: "provider-command",
    });
    if (!provider.ok) throw new Error(provider.error);
    const accountA = await run.plane.createProviderAccountDurable({
      id: "account-a",
      providerId: "provider",
      label: "A",
    });
    if (!accountA.ok) throw new Error(accountA.error);
    const accountB = await run.plane.createProviderAccountDurable({
      id: "account-b",
      providerId: "provider",
      label: "B",
    });
    if (!accountB.ok) throw new Error(accountB.error);
    const command = await run.plane.createCommandDurable({
      id: "provider-command",
      name: "provider command",
      argv: ["provider"],
      appendPrompt: true,
      providerId: "provider",
    });
    if (!command.ok) throw new Error(command.error);
    const inventory = run.plane.state.hostInventories.get("provider-host")!;
    const configuredInventory = {
      ...inventory,
      providerAccounts: [
        { providerAccountId: "account-a", commandId: "provider-command" },
        { providerAccountId: "account-b", commandId: "provider-command" },
      ],
    };
    run.plane.state.hostInventories.set("provider-host", configuredInventory);
    await run.plane.state.storage!.putHostInventory(configuredInventory);
    await run.plane.settleStorage();
    expect(
      resolveScheduledSessionTarget(
        run.plane.state,
        buildProviderCatalog(run.plane.state),
        {
          id: "probe",
          repositoryId: "provider-repo",
          prompt: "scheduled run",
          target: { providerId: "provider" },
          fallbacks: [],
          targetLabels: ["provider"],
          queueTtlSeconds: 60,
          queueExpiresAt: "2026-01-01T00:01:00.000Z",
          timeout: 30,
          priority: 0,
          requiredLabels: [],
          onConflict: "queue",
          status: "queued",
          queueShard: 0,
          createdAt: NOW,
        },
        "provider-host",
      ),
    ).toMatchObject({ providerAccountId: "account-a" });
    const assigned = await scheduled(run.plane, "provider-repo", "provider-lock", {
      providerId: "provider",
    });
    expect(assigned).toMatchObject({
      status: "running",
      resolvedRoute: { providerAccountId: "account-a" },
    });
    await run.plane.handleHostMessageDurable(
      {
        type: "session:status",
        sessionId: assigned.id,
        worktreeId: null,
        attemptId: assigned.attemptId!,
        status: "failed",
        errorCode: "usage_limit",
      },
      run.connectionId,
    );
    const rerouted = await ctx.storage.getSession(assigned.id);
    expect(rerouted).toMatchObject({
      status: "running",
      resolvedRoute: { providerAccountId: "account-b" },
    });
    expect((await ctx.storage.getProviderAccount("account-a"))?.usageLimitedUntil).toBeTruthy();
  });
});
