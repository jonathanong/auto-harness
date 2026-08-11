import { describe, expect, it } from "vitest";

import { createControlPlane } from "./create-plane.ts";
import {
  buildProviderCatalog,
  resolveScheduledSessionTarget,
} from "./control-plane-session-target.ts";
import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("ScheduledMissingProvider");
const NOW = "2026-01-01T00:00:00.000Z";

describe("scheduled provider deletion", () => {
  it("evicts a deleted account and immediately assigns its fallback", async () => {
    if (!ctx.available || !ctx.storage) return;
    const created = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      connectionIdFactory: () => "missing-provider-connection",
      idFactory: () => "missing-provider-session",
      now: () => NOW,
      shardCount: 1,
    });
    await created.plane.createProviderDurable({
      id: "missing-provider",
      name: "provider",
      defaultCommandId: "missing-provider-command",
    });
    await created.plane.createProviderAccountDurable({
      id: "missing-account-a",
      providerId: "missing-provider",
      label: "A",
    });
    await created.plane.createProviderAccountDurable({
      id: "missing-account-b",
      providerId: "missing-provider",
      label: "B",
    });
    await created.plane.createCommandDurable({
      id: "missing-provider-command",
      name: "provider command",
      argv: ["provider"],
      appendPrompt: true,
      providerId: "missing-provider",
    });
    await created.plane.settleStorage();
    const registered = await created.plane.registerHostDurable({
      hostId: "missing-provider-host",
      worktrees: [],
      repositories: [{ id: "missing-provider-repo", path: "/repo", defaultBranch: "main" }],
      commandProfiles: [],
      capabilities: ["scheduled-main-checkout"],
      replaceExisting: true,
    });
    if (!registered.ok) throw new Error(registered.error);
    const inventory = created.plane.state.hostInventories.get("missing-provider-host")!;
    const configuredInventory = {
      ...inventory,
      providerAccounts: [
        { providerAccountId: "missing-account-a", commandId: "missing-provider-command" },
        { providerAccountId: "missing-account-b", commandId: "missing-provider-command" },
      ],
    };
    created.plane.state.hostInventories.set("missing-provider-host", configuredInventory);
    await created.plane.state.storage!.putHostInventory(configuredInventory);
    const session = await created.plane.createSessionDurable({
      repositoryId: "missing-provider-repo",
      prompt: "scheduled run",
      target: { providerId: "missing-provider" },
      timeout: 30,
      type: "scheduled",
      source: "schedule",
      concurrencyId: "missing-provider-lock",
    });
    if (!session.ok) throw new Error(session.error);
    expect(
      resolveScheduledSessionTarget(
        created.plane.state,
        buildProviderCatalog(created.plane.state),
        created.plane.state.sessions.get(session.session.id)!,
        "missing-provider-host",
      ),
    ).toMatchObject({ providerAccountId: "missing-account-a" });
    expect(await created.plane.assignScheduledQueuedDurable()).toHaveLength(1);
    const first = created.plane.state.sessions.get(session.session.id)!;
    expect(first.resolvedRoute?.providerAccountId).toBe("missing-account-a");

    await ctx.storage.deleteProviderAccount("missing-account-a");
    await created.plane.handleHostMessageDurable(
      {
        type: "session:status",
        sessionId: first.id,
        worktreeId: null,
        attemptId: first.attemptId!,
        status: "failed",
        errorCode: "usage_limit",
      },
      registered.connectionId,
    );

    expect(created.plane.state.providerAccounts.has("missing-account-a")).toBe(false);
    expect(await ctx.storage.getSession(first.id)).toMatchObject({
      status: "running",
      resolvedRoute: { providerAccountId: "missing-account-b" },
    });
  });
});
