/* eslint-disable max-lines -- residual durable session branches share one focused fixture. */
import { describe, expect, it } from "vitest";

import { cancelSessionDurable } from "./control-plane-cancel-durable.ts";
import { setDurableReadStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { buildSessionRecord, validateSessionCreate } from "./control-plane-session-create.ts";
import {
  cloneSessionDurable,
  createSessionDurable,
  createGitHubIngressSessionDurable,
  resumeSessionDurable,
} from "./control-plane-sessions-durable.ts";
import { createSession, supersedeSession } from "./control-plane-sessions.ts";
import type { SessionRecord } from "./db/types.ts";
import type {
  GitHubIngressConfigRecord,
  IntegrationSessionFence,
} from "./db/plane-storage-types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function row(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s",
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
    onConflict: "queue",
    status: "queued",
    queueShard: 0,
    createdAt: NOW,
    type: "prompt",
    source: "api",
    ...over,
  };
}

function commandState() {
  const state = createControlPlaneState({ idFactory: () => "new", now: () => NOW });
  state.commands.set("cmd", {
    id: "cmd",
    name: "command",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
  });
  return state;
}

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

const githubFence: IntegrationSessionFence = {
  id: "github-ingress",
  type: "github-ingress",
  storageId: "github-ingress",
  generation: "generation",
  version: 1,
  enabled: true,
};

function githubBody(concurrencyId = "github-comment:issue_comment:42:99") {
  return {
    repositoryId: "repo",
    prompt: "handle GitHub comment",
    target: { commandId: "cmd" },
    timeout: 30,
    concurrencyId,
  };
}

describe("session state-machine residual coverage", () => {
  it("rejects durable cancellation when a running main-checkout lost its fence", async () => {
    const state = commandState();
    setDurableReadStorage(state, {});
    state.sessions.set("s", row({ status: "running", mainCheckoutLease: true, hostId: null }));

    await expect(cancelSessionDurable(state, "s")).resolves.toEqual({
      ok: false,
      error: "session changed before cancellation",
    });
  });

  it("rejects unresolved create targets in both preparation paths", () => {
    const state = createControlPlaneState();
    const body = {
      repositoryId: "repo",
      prompt: "run",
      target: { commandId: "missing" },
      timeout: 30,
    };
    expect(validateSessionCreate(state, body)).toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
    });
    expect(createSession(state, body)).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
  });

  it("keeps trusted schedule provenance during durable preparation", () => {
    const prepared = validateSessionCreate(
      commandState(),
      {
        repositoryId: "repo",
        prompt: "run",
        target: { commandId: "cmd" },
        timeout: 30,
        scheduleId: "nightly",
      },
      { allowScheduleId: true },
    );
    expect(prepared).toMatchObject({ ok: true, scheduleId: "nightly" });
    if (!prepared.ok) throw new Error("expected prepared session");
    expect(buildSessionRecord(commandState(), prepared).scheduleId).toBe("nightly");
  });

  it("authoritatively checks a missing durable resume source", async () => {
    const state = commandState();
    setDurableReadStorage(state, { getSession: async () => null });
    await expect(resumeSessionDurable(state, "missing")).resolves.toEqual({
      ok: false,
      error: "session not found",
    });
  });

  it("does not deduplicate GitHub ingress from a stale process-local session", async () => {
    const state = commandState();
    state.repositories.set("repo", {
      id: "repo",
      name: "repository",
      url: "https://example.test/repository",
      defaultBranch: "main",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const concurrencyId = "github-comment:issue_comment:42:99";
    state.sessions.set("stale", row({ id: "stale", concurrencyId }));
    let durableLookup = 0;
    setDurableReadStorage(state, {
      getActiveSessionByConcurrencyId: async () => {
        durableLookup += 1;
        return null;
      },
      createSession: async (session: SessionRecord) => ({ created: true, session }),
    });

    await expect(
      createGitHubIngressSessionDurable(state, {
        repositoryId: "repo",
        prompt: "rerun terminal delivery",
        target: { commandId: "cmd" },
        timeout: 30,
        concurrencyId,
      }),
    ).resolves.toMatchObject({ ok: true, created: true, session: { id: "new" } });
    expect(durableLookup).toBe(1);
  });

  it("covers malformed and fenced GitHub ingress admission reads", async () => {
    const malformed = commandState();
    setDurableReadStorage(malformed, { getActiveSessionByConcurrencyId: async () => null });
    await expect(createGitHubIngressSessionDurable(malformed, null)).resolves.toMatchObject({
      ok: false,
    });

    const missing = commandState();
    setDurableReadStorage(missing, {
      getGitHubIngressConfig: async () => null,
      getActiveSessionByConcurrencyId: async () => null,
    });
    await expect(
      createGitHubIngressSessionDurable(
        missing,
        { ...githubBody(), target: { commandId: "missing" } },
        { integrationFence: githubFence },
      ),
    ).resolves.toMatchObject({ ok: false, code: "VALIDATION_ERROR" });

    const changed = commandState();
    changed.repositories.set("repo", {
      id: "repo",
      name: "repository",
      url: "https://example.test/repository",
      defaultBranch: "main",
      createdAt: NOW,
      updatedAt: NOW,
    });
    let reads = 0;
    const active = row({ id: "active", concurrencyId: githubBody().concurrencyId });
    setDurableReadStorage(changed, {
      getGitHubIngressConfig: async () => {
        reads += 1;
        return reads === 1 ? githubConfig() : githubConfig({ version: 2 });
      },
      getActiveSessionByConcurrencyId: async () => active,
      createSession: async (session: SessionRecord) => ({ created: true, session }),
    });
    await expect(
      createGitHubIngressSessionDurable(changed, githubBody(), {
        integrationFence: githubFence,
      }),
    ).resolves.toMatchObject({ ok: true, created: true });
    expect(reads).toBe(2);

    const disappeared = commandState();
    disappeared.repositories.set("repo", {
      id: "repo",
      name: "repository",
      url: "https://example.test/repository",
      defaultBranch: "main",
      createdAt: NOW,
      updatedAt: NOW,
    });
    let disappearanceReads = 0;
    setDurableReadStorage(disappeared, {
      getGitHubIngressConfig: async () => {
        disappearanceReads += 1;
        return disappearanceReads === 1 ? githubConfig() : null;
      },
      getActiveSessionByConcurrencyId: async () => active,
      createSession: async (session: SessionRecord) => ({ created: true, session }),
    });
    await expect(
      createGitHubIngressSessionDurable(disappeared, githubBody(), {
        integrationFence: githubFence,
      }),
    ).resolves.toMatchObject({ ok: true, created: true });
    expect(disappearanceReads).toBe(2);
  });

  it("deduplicates an active GitHub ingress session with a stable fence", async () => {
    const state = commandState();
    const active = row({ id: "active", concurrencyId: githubBody().concurrencyId });
    const config = githubConfig();
    let reads = 0;
    setDurableReadStorage(state, {
      getGitHubIngressConfig: async () => {
        reads += 1;
        return config;
      },
      getActiveSessionByConcurrencyId: async () => active,
    });

    await expect(
      createGitHubIngressSessionDurable(state, githubBody(), {
        integrationFence: githubFence,
      }),
    ).resolves.toMatchObject({ ok: true, created: false, session: { id: "active" } });
    expect(reads).toBe(2);
    expect(state.sessions.get("active")).toMatchObject({
      concurrencyId: githubBody().concurrencyId,
    });
  });

  it("persists an ordinary queued supersession without a concurrency lock", () => {
    const state = commandState();
    state.sessions.set("s", row());
    supersedeSession(state, "s", "superseded");
    expect(state.sessions.get("s")).toMatchObject({
      status: "cancelled",
      errorMessage: "superseded",
      worktreeId: null,
      hostId: null,
    });
  });

  it("maps a durable clone id collision to a public conflict", async () => {
    const state = commandState();
    state.providers.set("provider", {
      id: "provider",
      name: "provider",
      defaultCommandId: "cmd",
      createdAt: NOW,
      updatedAt: NOW,
    });
    state.providerAccounts.set("account", {
      id: "account",
      providerId: "provider",
      label: "account",
      usageLimitCooldownSeconds: 0,
      maxConcurrentSessions: 1,
      usageLimitedUntil: null,
      lastUsageLimitedAt: null,
      lastAssignedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const source = row({ status: "completed", completedAt: NOW });
    const conflict = new Error("collision");
    conflict.name = "SessionIdCollisionError";
    setDurableReadStorage(state, {
      getSession: async () => source,
      createSession: async () => {
        throw conflict;
      },
    });
    await expect(cloneSessionDurable(state, "s")).resolves.toEqual({
      ok: false,
      error: "clone creation conflicted; retry the request",
      code: "CONFLICT",
    });
    state.storage!.createSession = async () => {
      throw new Error("storage unavailable");
    };
    await expect(cloneSessionDurable(state, "s")).rejects.toThrow("storage unavailable");
  });

  it("maps a closed repository during durable clone admission", async () => {
    const state = commandState();
    const source = row({ status: "completed", completedAt: NOW });
    const closed = Object.assign(new Error("closed"), {
      name: "RepositoryAdmissionClosedError",
    });
    setDurableReadStorage(state, {
      getSession: async () => source,
      createSession: async () => {
        throw closed;
      },
    });
    await expect(cloneSessionDurable(state, "s")).resolves.toMatchObject({
      ok: false,
      code: "REPOSITORY_ADMISSION_CLOSED",
    });
  });

  it("rejects a missing durable clone source before preparing it", async () => {
    const state = commandState();
    setDurableReadStorage(state, { getSession: async () => null });
    await expect(cloneSessionDurable(state, "missing")).resolves.toEqual({
      ok: false,
      error: "session not found",
      code: "NOT_FOUND",
    });
  });

  it("clones against an isolated durable provider catalog snapshot", async () => {
    const state = commandState();
    const source = row({ status: "completed", completedAt: NOW });
    state.repositories.set("repo", {
      id: "repo",
      name: "repo",
      url: "https://example.test/repo.git",
      defaultBranch: "main",
      createdAt: NOW,
      updatedAt: NOW,
    });
    state.providers.set("provider", {
      id: "provider",
      name: "provider",
      defaultCommandId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    state.providerAccounts.set("account", {
      id: "account",
      providerId: "provider",
      label: "account@example.test",
      createdAt: NOW,
      updatedAt: NOW,
    });
    setDurableReadStorage(state, {
      getSession: async () => source,
      createSession: async (session: SessionRecord) => ({ session, created: true }),
    });

    await expect(cloneSessionDurable(state, source.id)).resolves.toMatchObject({
      ok: true,
      created: true,
      session: { id: "new" },
    });
  });

  it("hydrates workspace references for durable create and clone snapshots", async () => {
    const state = commandState();
    const pool = {
      id: "pool",
      name: "pool",
      setupProfiles: [],
      destroyWorkspaceAfter: false,
      createdAt: NOW,
      updatedAt: NOW,
    } as never;
    setDurableReadStorage(state, {
      getWorkspacePool: async () => pool,
      createSession: async (session: SessionRecord) => ({ session, created: true }),
      listCommands: async () => [...state.commands.values()],
      listProviders: async () => [],
      listProviderAccounts: async () => [],
    });
    await expect(
      createSessionDurable(state, {
        repositoryId: null,
        workspacePoolId: "pool",
        prompt: "workspace",
        target: { commandId: "cmd" },
        timeout: 30,
      }),
    ).resolves.toMatchObject({ ok: true });

    const source = row({
      id: "workspace-source",
      repositoryId: null,
      workspacePoolId: "pool",
      status: "completed",
      completedAt: NOW,
    });
    state.storage!.getSession = async () => source;
    state.storage!.getWorkspacePool = async () => pool;
    await expect(cloneSessionDurable(state, source.id)).resolves.toMatchObject({
      ok: true,
      created: true,
    });
  });

  it("refreshes the durable catalog when resuming with a target override", async () => {
    const state = commandState();
    const source = row({
      status: "completed",
      hostId: "host",
      resolvedRoute: { hostId: "host", commandId: "cmd", targetIndex: 0 },
    });
    state.repositories.set("repo", {
      id: "repo",
      name: "repo",
      url: "https://example.test/repo.git",
      defaultBranch: "main",
      createdAt: NOW,
      updatedAt: NOW,
    });
    setDurableReadStorage(state, {
      getSession: async () => source,
      getRepository: async () => state.repositories.get("repo"),
      createSession: async (session: SessionRecord) => ({ session, created: true }),
    });
    await expect(
      resumeSessionDurable(state, source.id, { target: { commandId: "cmd" } }),
    ).resolves.toMatchObject({ ok: true });
  });
});
