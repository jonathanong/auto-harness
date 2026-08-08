import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { listSessionTargets } from "./control-plane-session-targets.ts";

describe("listSessionTargets", () => {
  it("lists provider accounts and standalone commands, sorted by label", () => {
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
