/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import type { HostInventoryRecord } from "./db/plane-storage.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { listSessionTargets } from "./control-plane-session-targets.ts";

describe("listSessionTargets", () => {
  it("lists providers and all commands, with availability hints", () => {
    const state = createControlPlaneState();
    state.providers.set("prov-1", {
      id: "prov-1",
      name: "claude",
      defaultCommandId: "cmd-owned",
      createdAt: "t",
      updatedAt: "t",
    });
    state.providerAccounts.set("acct-1", {
      id: "acct-1",
      providerId: "prov-1",
      label: "z@y.com",
      createdAt: "t",
      updatedAt: "t",
    });
    state.hostInventories.set("host-1", {
      hostId: "host-1",
      repositories: [],
      providerAccounts: [{ providerAccountId: "acct-1" }],
      commandProfiles: {},
      updatedAt: "t",
    });
    state.worktrees.set("wt-1", {
      id: "wt-1",
      name: "wt-1",
      hostId: "host-1",
      repositoryId: "repo-1",
      path: "/wt",
      labels: [],
      status: "idle",
      online: true,
    });
    state.commands.set("cmd-standalone", {
      id: "cmd-standalone",
      name: "aardvark",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    // Provider-owned commands are exact-command targets too.
    state.commands.set("cmd-owned", {
      id: "cmd-owned",
      name: "claude-print",
      argv: ["claude", "-p"],
      appendPrompt: true,
      providerId: "prov-1",
      createdAt: "t",
      updatedAt: "t",
    });

    const targets = listSessionTargets(state);
    expect(targets).toEqual([
      {
        kind: "command",
        id: "cmd-standalone",
        label: "aardvark",
        providerId: null,
        available: true,
      },
      { kind: "provider", id: "prov-1", label: "claude", available: true },
      {
        kind: "command",
        id: "cmd-owned",
        label: "claude-print",
        providerId: "prov-1",
        available: true,
      },
    ]);
  });

  it("includes unavailable providers without attached healthy accounts", () => {
    const state = createControlPlaneState();
    state.providers.set("prov-1", {
      id: "prov-1",
      name: "claude",
      defaultCommandId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    state.providerAccounts.set("acct-unattached", {
      id: "acct-unattached",
      providerId: "prov-1",
      label: "z@y.com",
      createdAt: "t",
      updatedAt: "t",
    });
    // A host inventory exists, but this account isn't in its providerAccounts list.
    state.hostInventories.set("host-1", {
      hostId: "host-1",
      repositories: [],
      providerAccounts: [],
      commandProfiles: {},
      updatedAt: "t",
    });
    expect(listSessionTargets(state)).toEqual([
      { kind: "provider", id: "prov-1", label: "claude", available: false },
    ]);
  });

  it("doesn't crash on a stale real-storage host record missing providerAccounts at runtime", () => {
    const state = createControlPlaneState();
    state.providers.set("prov-1", {
      id: "prov-1",
      name: "claude",
      defaultCommandId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    state.providerAccounts.set("acct-1", {
      id: "acct-1",
      providerId: "prov-1",
      label: "z@y.com",
      createdAt: "t",
      updatedAt: "t",
    });
    // The field is typed as required, but a record persisted before it existed can still
    // lack it — the picker must mark the provider unavailable, not throw.
    const stale = {
      hostId: "host-1",
      repositories: [],
      commandProfiles: {},
    } as unknown as HostInventoryRecord;
    state.hostInventories.set("host-1", stale);
    expect(listSessionTargets(state)).toEqual([
      { kind: "provider", id: "prov-1", label: "claude", available: false },
    ]);
  });

  it("does not need account records to list provider catalog entries", () => {
    const state = createControlPlaneState();
    state.providerAccounts.set("orphan", {
      id: "orphan",
      providerId: "gone",
      label: "x@y.com",
      createdAt: "t",
      updatedAt: "t",
    });
    expect(listSessionTargets(state)).toEqual([]);
  });

  it("returns an empty list when nothing is catalogued", () => {
    expect(listSessionTargets(createControlPlaneState())).toEqual([]);
  });

  it("marks provider routes unavailable for limited or unusable worktrees", () => {
    const state = createControlPlaneState({ now: () => "2026-01-01T00:00:00.000Z" });
    state.providers.set("prov-1", {
      id: "prov-1",
      name: "claude",
      defaultCommandId: "cmd-provider",
      createdAt: "t",
      updatedAt: "t",
    });
    state.providerAccounts.set("acct-1", {
      id: "acct-1",
      providerId: "prov-1",
      label: "account",
      usageLimitedUntil: "2026-01-02T00:00:00.000Z",
      createdAt: "t",
      updatedAt: "t",
    });
    state.hostInventories.set("host-1", {
      hostId: "host-1",
      repositories: [],
      providerAccounts: [{ providerAccountId: "acct-1" }],
      commandProfiles: {},
      updatedAt: "t",
    });
    state.commands.set("cmd-empty", {
      id: "cmd-empty",
      name: "empty",
      argv: [],
      appendPrompt: false,
      providerId: "prov-1",
      createdAt: "t",
      updatedAt: "t",
    });
    state.commands.set("cmd-provider", {
      id: "cmd-provider",
      name: "provider command",
      argv: ["claude"],
      appendPrompt: true,
      providerId: "prov-1",
      createdAt: "t",
      updatedAt: "t",
    });
    state.commands.set("cmd-standalone", {
      id: "cmd-standalone",
      name: "standalone",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    state.worktrees.set("wt-1", {
      id: "wt-1",
      name: "wt-1",
      hostId: "host-1",
      repositoryId: "repo-1",
      path: "/wt",
      labels: [],
      status: "idle",
      online: true,
    });

    expect(listSessionTargets(state)).toEqual([
      { kind: "provider", id: "prov-1", label: "claude", available: false },
      { kind: "command", id: "cmd-empty", label: "empty", providerId: "prov-1", available: false },
      {
        kind: "command",
        id: "cmd-provider",
        label: "provider command",
        providerId: "prov-1",
        available: false,
      },
      {
        kind: "command",
        id: "cmd-standalone",
        label: "standalone",
        providerId: null,
        available: true,
      },
    ]);

    state.providerAccounts.get("acct-1")!.usageLimitedUntil = null;
    state.hostInventories.get("host-1")!.repositories = [
      {
        id: "repo-1",
        path: "/repo",
        worktrees: [],
        providerAccountOverrides: { "acct-1": { enabled: false } },
      },
    ];
    expect(listSessionTargets(state).find((target) => target.id === "prov-1")).toMatchObject({
      available: false,
    });
    state.hostInventories.get("host-1")!.repositories = [];
    expect(listSessionTargets(state).find((target) => target.id === "prov-1")).toMatchObject({
      available: true,
    });
    state.providers.get("prov-1")!.defaultCommandId = null;
    expect(listSessionTargets(state).find((target) => target.id === "prov-1")).toMatchObject({
      available: false,
    });
    state.providers.get("prov-1")!.defaultCommandId = "missing-command";
    expect(listSessionTargets(state).find((target) => target.id === "prov-1")).toMatchObject({
      available: false,
    });
    state.worktrees.get("wt-1")!.status = "busy";
    expect(
      listSessionTargets(state).find((target) => target.id === "cmd-standalone"),
    ).toMatchObject({
      available: false,
    });
    state.worktrees.get("wt-1")!.status = "idle";
    state.worktrees.get("wt-1")!.online = false;
    expect(
      listSessionTargets(state).find((target) => target.id === "cmd-standalone"),
    ).toMatchObject({
      available: false,
    });
    state.worktrees.get("wt-1")!.online = true;
    state.drainingHosts.add("host-1");
    expect(
      listSessionTargets(state).find((target) => target.id === "cmd-standalone"),
    ).toMatchObject({
      available: false,
    });
    state.drainingHosts.clear();
    state.disconnectedHosts.set("host-1", { lastHeartbeatAt: "t" });
    expect(
      listSessionTargets(state).find((target) => target.id === "cmd-standalone"),
    ).toMatchObject({
      available: false,
    });
  });
});
