import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { resolveSessionTargetDisplayName } from "./control-plane-session-target-display-name.ts";

describe("resolveSessionTargetDisplayName", () => {
  it("names a standalone command by its name", () => {
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
    expect(resolveSessionTargetDisplayName(state, { commandId: "cmd-1" })).toEqual({
      ok: true,
      displayName: "echo hello",
    });
  });

  it("rejects a commandId that doesn't exist", () => {
    const state = createControlPlaneState();
    expect(resolveSessionTargetDisplayName(state, { commandId: "missing" })).toEqual({
      ok: false,
      error: "commandId missing not found",
    });
  });

  it("names a provider-owned command as an exact command target", () => {
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
    state.providers.set("prov-1", {
      id: "prov-1",
      name: "claude",
      defaultCommandId: "cmd-1",
      createdAt: "t",
      updatedAt: "t",
    });
    expect(resolveSessionTargetDisplayName(state, { commandId: "cmd-1" })).toEqual({
      ok: true,
      displayName: "claude — claude-print",
    });
  });

  it("names a provider target", () => {
    const state = createControlPlaneState();
    state.providers.set("prov-1", {
      id: "prov-1",
      name: "claude",
      defaultCommandId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    expect(resolveSessionTargetDisplayName(state, { providerId: "prov-1" })).toEqual({
      ok: true,
      displayName: "claude",
    });
  });

  it("rejects a providerId that doesn't exist", () => {
    const state = createControlPlaneState();
    expect(resolveSessionTargetDisplayName(state, { providerId: "missing" })).toEqual({
      ok: false,
      error: "providerId missing not found",
    });
  });

  it("rejects a provider-owned command whose provider is missing (defensive)", () => {
    const state = createControlPlaneState();
    state.commands.set("cmd-1", {
      id: "cmd-1",
      providerId: "gone",
      name: "cmd",
      argv: ["cmd"],
      appendPrompt: true,
      createdAt: "t",
      updatedAt: "t",
    });
    expect(resolveSessionTargetDisplayName(state, { commandId: "cmd-1" })).toEqual({
      ok: false,
      error: "provider gone not found",
    });
  });
});
