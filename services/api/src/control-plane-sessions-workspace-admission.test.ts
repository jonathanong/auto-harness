import { expect, it } from "vitest";

import { validateSessionCreate } from "./control-plane-session-create.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { createSession } from "./control-plane-sessions.ts";

function workspaceState() {
  const state = createControlPlaneState();
  state.workspacePools.set("pool", {
    id: "pool",
    name: "pool",
    setupProfiles: [],
    destroyWorkspaceAfter: false,
    createdAt: "now",
    updatedAt: "now",
  });
  return state;
}

it("rejects an oversized workspace assignment through the local createSession path", () => {
  const state = workspaceState();
  state.commands.set("command", {
    id: "command",
    name: "command",
    argv: ["command"],
    appendPrompt: true,
    providerId: null,
  });
  const body = {
    repositoryId: null,
    workspacePoolId: "pool",
    prompt: "\u0000".repeat(30_000),
    target: { commandId: "command" },
    timeout: 30,
    type: "workspace",
  };

  expect(createSession(state, body)).toEqual({
    ok: false,
    code: "VALIDATION_ERROR",
    error: "workspace session assignment exceeds 122880 byte WebSocket limit",
  });
  expect(state.sessions.size).toBe(0);
});

it("rejects a provider workspace target with no route that could be bounded at admission", () => {
  const state = workspaceState();
  state.providers.set("provider", {
    id: "provider",
    name: "provider",
    defaultCommandId: "future-command",
    createdAt: "now",
    updatedAt: "now",
  });

  expect(
    validateSessionCreate(state, {
      repositoryId: null,
      workspacePoolId: "pool",
      prompt: "\u0000".repeat(30_000),
      target: { providerId: "provider" },
      timeout: 30,
      type: "workspace",
    }),
  ).toEqual({
    ok: false,
    code: "VALIDATION_ERROR",
    error: "workspace session has no currently routable assignment",
  });
});
