import { describe, expect, it } from "vitest";

import type { HostInventoryRecord } from "./db/plane-storage.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { listSessionTargets } from "./control-plane-session-targets.ts";

describe("listSessionTargets", () => {
  it("lists attached provider accounts and standalone commands, sorted by label", () => {
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
    state.agentHosts.set("host-1", {
      hostId: "host-1",
      repositories: [],
      providerAccounts: [{ providerAccountId: "acct-1" }],
      commandProfiles: {},
      updatedAt: "t",
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
    // Provider-owned command — reached via the account's cascade, not listed directly.
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
      { kind: "command", id: "cmd-standalone", label: "aardvark" },
      { kind: "provider-account", id: "acct-1", label: "claude — z@y.com", providerId: "prov-1" },
    ]);
  });

  it("excludes a provider account that exists but isn't attached to any host", () => {
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
    state.agentHosts.set("host-1", {
      hostId: "host-1",
      repositories: [],
      providerAccounts: [],
      commandProfiles: {},
      updatedAt: "t",
    });
    expect(listSessionTargets(state)).toEqual([]);
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
    // lack it — the picker must degrade to "not attached", not throw.
    const stale = {
      hostId: "host-1",
      repositories: [],
      commandProfiles: {},
    } as unknown as HostInventoryRecord;
    state.agentHosts.set("host-1", stale);
    expect(listSessionTargets(state)).toEqual([]);
  });

  it("skips a provider account whose provider record is missing (defensive)", () => {
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
});
