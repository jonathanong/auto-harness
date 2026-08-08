import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { resolveSessionTargetLabel } from "./control-plane-session-target-label.ts";

describe("resolveSessionTargetLabel", () => {
  it("labels a standalone command by its name", () => {
    const state = createControlPlaneState();
    state.commands.set("cmd-1", {
      id: "cmd-1",
      name: "echo hello",
      argv: ["echo", "hello"],
      appendPrompt: true,
      providerId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    expect(resolveSessionTargetLabel(state, undefined, "cmd-1")).toEqual({
      ok: true,
      label: "echo hello",
    });
  });

  it("rejects a commandId that doesn't exist", () => {
    const state = createControlPlaneState();
    expect(resolveSessionTargetLabel(state, undefined, "missing")).toEqual({
      ok: false,
      error: "commandId missing not found",
    });
  });

  it("rejects a provider-owned commandId as a direct target — must go through its provider account", () => {
    const state = createControlPlaneState();
    state.commands.set("cmd-1", {
      id: "cmd-1",
      name: "claude-print",
      argv: ["claude", "-p"],
      appendPrompt: true,
      providerId: "prov-1",
      createdAt: "t",
      updatedAt: "t",
    });
    expect(resolveSessionTargetLabel(state, undefined, "cmd-1")).toEqual({
      ok: false,
      error: "commandId cmd-1 is owned by a provider; target its provider account instead",
    });
  });

  it("labels a provider account as 'provider name — account label'", () => {
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
      label: "x@y.com",
      createdAt: "t",
      updatedAt: "t",
    });
    expect(resolveSessionTargetLabel(state, "acct-1", undefined)).toEqual({
      ok: true,
      label: "claude — x@y.com",
    });
  });

  it("rejects a providerAccountId that doesn't exist", () => {
    const state = createControlPlaneState();
    expect(resolveSessionTargetLabel(state, "missing", undefined)).toEqual({
      ok: false,
      error: "providerAccountId missing not found",
    });
  });

  it("rejects a providerAccountId whose provider is missing (defensive)", () => {
    const state = createControlPlaneState();
    state.providerAccounts.set("acct-1", {
      id: "acct-1",
      providerId: "gone",
      label: "x@y.com",
      createdAt: "t",
      updatedAt: "t",
    });
    expect(resolveSessionTargetLabel(state, "acct-1", undefined)).toEqual({
      ok: false,
      error: "provider gone not found",
    });
  });
});
