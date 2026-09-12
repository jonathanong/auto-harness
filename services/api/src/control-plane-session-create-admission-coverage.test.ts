import { expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { validateSessionCreate } from "./control-plane-session-create.ts";

it("sizes every provider-account admission route that a workspace pool can expose", () => {
  const state = createControlPlaneState();
  state.workspacePools.set("pool", {
    id: "pool",
    name: "pool",
    setupProfiles: [],
    destroyWorkspaceAfter: false,
    createdAt: "now",
    updatedAt: "now",
  });
  state.providers.set("provider", {
    id: "provider",
    name: "provider",
    defaultCommandId: "provider-command",
    createdAt: "now",
    updatedAt: "now",
  });
  state.commands.set("deleted-command", {
    id: "deleted-command",
    name: "replaced-command",
    argv: ["echo"],
    appendPrompt: true,
    providerId: "provider",
    createdAt: "now",
    updatedAt: "now",
  });
  state.commands.set("provider-command", {
    id: "provider-command",
    name: "provider-command",
    argv: ["provider"],
    appendPrompt: true,
    providerId: "provider",
    createdAt: "now",
    updatedAt: "now",
  });
  state.commands.set("account-command", {
    id: "account-command",
    name: "account-command",
    argv: ["account"],
    appendPrompt: false,
    providerId: "provider",
    createdAt: "now",
    updatedAt: "now",
  });
  state.providerAccounts.set("matching", {
    id: "matching",
    providerId: "provider",
    label: "matching",
    createdAt: "now",
    updatedAt: "now",
  });
  state.providerAccounts.set("other", {
    id: "other",
    providerId: "other-provider",
    label: "other",
    createdAt: "now",
    updatedAt: "now",
  });
  state.hostInventories.set("not-opted-in", {
    hostId: "not-opted-in",
    version: 1,
    updatedAt: "now",
    repositories: [],
    providerAccounts: [],
  });
  state.hostInventories.set("opted-in", {
    hostId: "opted-in",
    version: 1,
    updatedAt: "now",
    repositories: [],
    workspacePools: [{ workspacePoolId: "pool", slots: [] }],
    providerAccounts: [
      { providerAccountId: "missing" },
      { providerAccountId: "other" },
      { providerAccountId: "matching", commandId: "missing-command" },
      { providerAccountId: "matching", commandId: "account-command" },
    ],
  });

  expect(
    validateSessionCreate(state, {
      repositoryId: null,
      workspacePoolId: "pool",
      prompt: "inspect",
      target: { commandId: "provider-command" },
      timeout: 30,
      type: "workspace",
    }),
  ).toMatchObject({ ok: true });
  expect(
    validateSessionCreate(state, {
      repositoryId: null,
      workspacePoolId: "pool",
      prompt: "inspect",
      target: { providerId: "provider" },
      timeout: 30,
      type: "workspace",
    }),
  ).toMatchObject({ ok: true });
});

it("rejects provider targets whose current routes cannot be frozen into a bounded frame", () => {
  const state = createControlPlaneState();
  state.workspacePools.set("pool", {
    id: "pool",
    name: "pool",
    setupProfiles: [],
    destroyWorkspaceAfter: false,
    createdAt: "now",
    updatedAt: "now",
  });
  state.providers.set("provider", {
    id: "provider",
    name: "provider",
    defaultCommandId: "deleted-command",
    createdAt: "now",
    updatedAt: "now",
  });

  expect(
    validateSessionCreate(state, {
      repositoryId: null,
      workspacePoolId: "pool",
      prompt: "inspect",
      target: { providerId: "provider" },
      timeout: 30,
      type: "workspace",
    }),
  ).toMatchObject({
    ok: false,
    error: "workspace session has no currently routable assignment",
  });
  expect(
    validateSessionCreate(state, {
      repositoryId: null,
      workspacePoolId: "pool",
      prompt: "inspect",
      target: { commandId: "deleted-command" },
      timeout: 30,
      type: "workspace",
    }),
  ).toMatchObject({ ok: false });
});
