import { expect, it, vi } from "vitest";

import { assignWorkspaceQueuedDurable } from "./control-plane-workspace-assign.ts";
import { workspacePlane } from "./test-helpers/workspace-session.ts";

it("retries a durable provider-account lease collision on a different local lease slot", async () => {
  const { plane, messages } = workspacePlane();
  expect(plane.createProvider({ id: "provider", name: "provider" }).ok).toBe(true);
  expect(
    plane.createCommand({
      id: "provider-command",
      name: "provider-command",
      argv: ["provider"],
      appendPrompt: true,
      providerId: "provider",
    }).ok,
  ).toBe(true);
  expect(
    plane.createProviderAccount({
      id: "account",
      providerId: "provider",
      label: "account",
      maxConcurrentSessions: 2,
    }).ok,
  ).toBe(true);
  plane.updateProvider("provider", { defaultCommandId: "provider-command" });
  const inventory = plane.getHostInventory("host-1");
  if (!inventory) throw new Error("workspace inventory missing");
  expect(
    plane.putHostInventory("host-1", {
      ...inventory,
      providerAccounts: [{ providerAccountId: "account" }],
    }).ok,
  ).toBe(true);
  plane.state.connections.get("connection-1")!.providerAccountReadiness = [
    { providerAccountId: "account", ready: true, fingerprint: "a".repeat(64) },
  ];
  const created = plane.createSession({
    repositoryId: null,
    workspacePoolId: "pool-1",
    prompt: "run provider",
    target: { providerId: "provider" },
    timeout: 60,
    type: "workspace",
    source: "api",
  });
  if (!created.ok) throw new Error(created.error);
  const tryAssignWorkspaceSession = vi
    .fn()
    .mockResolvedValueOnce("lease_collision")
    .mockResolvedValueOnce(true);
  plane.state.storage = { tryAssignWorkspaceSession } as never;

  await expect(
    assignWorkspaceQueuedDurable(plane.state, created.session.id, { readModelLoaded: true }),
  ).resolves.toHaveLength(1);
  expect(tryAssignWorkspaceSession).toHaveBeenCalledTimes(2);
  expect(tryAssignWorkspaceSession.mock.calls[0]?.[0]).toMatchObject({
    providerId: "provider",
    providerAccountId: "account",
    providerAccountLease: { slot: 0 },
  });
  expect(tryAssignWorkspaceSession.mock.calls[1]?.[0]).toMatchObject({
    providerAccountLease: { slot: 1 },
  });
  expect(messages.at(-1)).toMatchObject({ providerAccountId: "account" });
  expect(plane.state.providerAccountLeases.has("acct:account:0")).toBe(false);
});
