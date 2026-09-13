import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { createGitHubIngressSessionDurable } from "./control-plane-sessions-durable.ts";
import type { SessionRecord } from "./db/types.ts";
import type {
  GitHubIngressConfigRecord,
  IntegrationSessionFence,
} from "./db/plane-storage-types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function commandState() {
  const state = createControlPlaneState({ idFactory: () => "new", now: () => NOW });
  state.commands.set("cmd", {
    id: "cmd",
    name: "command",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
  });
  state.repositories.set("repo", {
    id: "repo",
    name: "repository",
    url: "https://example.test/repository",
    defaultBranch: "main",
    createdAt: NOW,
    updatedAt: NOW,
  });
  return state;
}

const githubFence: IntegrationSessionFence = {
  id: "github-ingress",
  type: "github-ingress",
  storageId: "github-ingress",
  generation: "generation",
  version: 1,
  enabled: true,
};

function githubConfig(over: Partial<GitHubIngressConfigRecord> = {}): GitHubIngressConfigRecord {
  return {
    id: "github-ingress",
    type: "github-ingress",
    encryptedSecret: "cipher",
    enabled: true,
    bindings: [],
    generation: "generation",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function githubBody() {
  return {
    repositoryId: "repo",
    prompt: "handle GitHub comment",
    target: { commandId: "cmd" },
    timeout: 30,
    concurrencyId: "github-comment:issue_comment:42:99",
  };
}

function activeRow(): SessionRecord {
  return {
    id: "active",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetDisplayNames: ["cmd"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    status: "queued",
    queueShard: 0,
    createdAt: NOW,
    concurrencyId: githubBody().concurrencyId,
  };
}

describe("in-memory GitHub ingress lock before fence", () => {
  it("returns the active session when the local fence has rotated", async () => {
    const state = commandState();
    state.githubIngressConfig = githubConfig({ version: 2 });
    state.sessions.set("active", activeRow());
    await expect(
      createGitHubIngressSessionDurable(state, githubBody(), { integrationFence: githubFence }),
    ).resolves.toMatchObject({ ok: true, created: false, session: { id: "active" } });
  });

  it("returns the active session when local GitHub config is gone", async () => {
    const state = commandState();
    state.sessions.set("active", activeRow());
    await expect(
      createGitHubIngressSessionDurable(state, githubBody(), { integrationFence: githubFence }),
    ).resolves.toMatchObject({ ok: true, created: false, session: { id: "active" } });
  });

  it("still conflicts a genuinely new create against a stale fence", async () => {
    const state = commandState();
    state.githubIngressConfig = githubConfig({ version: 2 });
    await expect(
      createGitHubIngressSessionDurable(state, githubBody(), { integrationFence: githubFence }),
    ).resolves.toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("ignores terminal and unrelated in-memory sessions when looking up the lock", async () => {
    const state = commandState();
    state.githubIngressConfig = githubConfig({ version: 2 });
    state.sessions.set("done", { ...activeRow(), id: "done", status: "failed" });
    state.sessions.set("other", {
      ...activeRow(),
      id: "other",
      concurrencyId: "github-comment:issue_comment:1:2",
    });
    await expect(
      createGitHubIngressSessionDurable(state, githubBody(), { integrationFence: githubFence }),
    ).resolves.toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("does not treat a non-GitHub concurrency id as an ingress lock", async () => {
    const state = commandState();
    state.githubIngressConfig = githubConfig({ version: 2 });
    state.sessions.set("active", {
      ...activeRow(),
      concurrencyId: "custom:delivery",
    });
    await expect(
      createGitHubIngressSessionDurable(
        state,
        { ...githubBody(), concurrencyId: "custom:delivery" },
        { integrationFence: githubFence },
      ),
    ).resolves.toMatchObject({ ok: false, code: "CONFLICT" });
    await expect(
      createGitHubIngressSessionDurable(state, null, { integrationFence: githubFence }),
    ).resolves.toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("creates when the in-memory fence still matches", async () => {
    const state = commandState();
    state.githubIngressConfig = githubConfig();
    await expect(
      createGitHubIngressSessionDurable(state, githubBody(), { integrationFence: githubFence }),
    ).resolves.toMatchObject({ ok: true, created: true, session: { id: "new" } });
  });
});
