import { expect, it } from "vitest";

import { buildSessionRecord, validateSessionCreate } from "./control-plane-session-create.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

function workspaceState() {
  const state = createControlPlaneState({
    idFactory: () => "session",
    now: () => "2026-01-01T00:00:00.000Z",
  });
  state.commands.set("command", {
    id: "command",
    name: "command",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
  });
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

function workspaceInput(overrides: Record<string, unknown> = {}) {
  return {
    repositoryId: null,
    workspacePoolId: "pool",
    prompt: "inspect",
    target: { commandId: "command" },
    timeout: 30,
    type: "workspace",
    ...overrides,
  };
}

it("includes explicit workspace destruction and metadata in a routed assignment admission frame", () => {
  const state = workspaceState();
  expect(
    validateSessionCreate(
      state,
      workspaceInput({ destroyWorkspaceAfter: true, metadata: { source: "api" } }),
    ),
  ).toMatchObject({ ok: true });
});

it("returns admission closure for a repository whose scheduling state changed", () => {
  const state = workspaceState();
  state.repositories.set("repository", {
    id: "repository",
    name: "repository",
    url: "https://example.test/repository",
    defaultBranch: "main",
    admissionState: "paused",
    admissionStateChangedAt: "now",
    createdAt: "now",
    updatedAt: "now",
  });
  expect(
    validateSessionCreate(state, {
      repositoryId: "repository",
      prompt: "inspect",
      target: { commandId: "command" },
      timeout: 30,
    }),
  ).toMatchObject({ ok: false });
});

it("uses false when a legacy workspace pool lacks a cleanup default", () => {
  const state = workspaceState();
  const pool = state.workspacePools.get("pool")! as Record<string, unknown>;
  delete pool.destroyWorkspaceAfter;
  const result = validateSessionCreate(state, workspaceInput());
  if (!result.ok) throw new Error(result.error);
  expect(buildSessionRecord(state, result)).toMatchObject({ destroyWorkspaceAfter: false });
});

it("treats command records removed during synchronous workspace admission as unroutable", () => {
  const state = workspaceState();
  const read = state.commands.get.bind(state.commands);
  let reads = 0;
  state.commands.get = (id) => {
    reads += 1;
    return reads === 2 ? undefined : read(id);
  };
  expect(validateSessionCreate(state, workspaceInput())).toMatchObject({ ok: true });
});

it("skips a provider default command removed while checking its workspace route", () => {
  const state = workspaceState();
  state.providers.set("provider", {
    id: "provider",
    name: "provider",
    defaultCommandId: "command",
    createdAt: "now",
    updatedAt: "now",
  });
  const read = state.commands.get.bind(state.commands);
  state.commands.get = () => undefined;
  expect(
    validateSessionCreate(state, workspaceInput({ target: { providerId: "provider" } })),
  ).toMatchObject({ ok: true });
  state.commands.get = read;
});
