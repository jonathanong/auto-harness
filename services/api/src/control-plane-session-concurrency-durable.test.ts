import { describe, expect, it } from "vitest";

import { createControlPlane } from "./create-plane.ts";
import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";
import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";
import type { SessionRecord } from "./db/types.ts";

const ctx = createDynamoTestCtx("SessionConcurrency");

describe("durable session concurrency", () => {
  it("validates a resume source and omits an absent CLI resume reference", async () => {
    const plane = new ControlPlane({
      idFactory: (() => {
        let id = 0;
        return () => `resume-${++id}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    seedBaseCommand(plane);
    plane.createSession(baseSessionBody());
    const source = plane.state.sessions.get("resume-1")!;
    Object.assign(source, { status: "completed", hostId: "host-1" });
    plane.state.storage = {
      createSession: async (session: SessionRecord) => ({ created: true, session }),
    } as never;

    await expect(plane.resumeSessionDurable(source.id)).resolves.toMatchObject({
      ok: true,
      created: true,
      session: {
        id: "resume-2",
        pinnedHostId: "host-1",
        pinExpiresAt: "2026-01-01T01:00:00.000Z",
      },
    });
    expect(plane.getSession("resume-2")).not.toHaveProperty("cliResumeRef");

    plane.state.sessions.set("invalid-source", {
      ...source,
      id: "invalid-source",
      commandId: "missing-command",
    });
    await expect(plane.resumeSessionDurable("invalid-source")).resolves.toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
    });
  });

  it("validates, atomically deduplicates, and releases terminal concurrency ids", async () => {
    if (!ctx.available || !ctx.storage) return;
    await ctx.storage.putCommand({
      id: "cmd-concurrency",
      name: "concurrency",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    let id = 0;
    const { plane } = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      idFactory: () => `session-${++id}`,
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    await plane.hydrateFromStorage();
    plane.createProvider({ id: "provider-1", name: "provider", defaultCommandId: null });
    plane.createProviderAccount({
      id: "account-1",
      providerId: "provider-1",
      label: "account",
    });

    await expect(plane.createSessionDurable(null)).resolves.toMatchObject({ ok: false });
    await expect(plane.createSessionDurable({})).resolves.toMatchObject({ ok: false });
    await expect(
      plane.createSessionDurable({
        repositoryId: "repo-1",
        prompt: "missing command",
        commandId: "missing",
        timeout: 30,
      }),
    ).resolves.toMatchObject({ ok: false, code: "VALIDATION_ERROR" });

    const body = {
      repositoryId: "repo-1",
      prompt: "shepherd PR",
      commandId: "cmd-concurrency",
      timeout: 30,
      concurrencyId: "filaments-pr-shepherd-123",
    };
    const first = await plane.createSessionDurable(body);
    const duplicate = await plane.createSessionDurable(body);
    expect(first).toMatchObject({ ok: true, created: true });
    expect(duplicate).toMatchObject({ ok: true, created: false });
    if (!first.ok || !duplicate.ok) return;
    expect(duplicate.session.id).toBe(first.session.id);

    plane.forceStatus(first.session.id, "completed");
    await plane.settleStorage();
    await expect(plane.createSessionDurable(body)).resolves.toMatchObject({
      ok: true,
      created: true,
    });
    await expect(
      plane.createSessionDurable({ ...body, concurrencyId: undefined }),
    ).resolves.toMatchObject({ ok: true, created: true });
    await expect(
      plane.createSessionDurable({
        repositoryId: "repo-1",
        prompt: "provider task",
        providerAccountId: "account-1",
        timeout: 20,
        priority: 4,
        requiredLabels: ["gpu"],
        ref: "main",
        metadata: { pr: 123 },
        type: "scheduled",
        source: "schedule",
      }),
    ).resolves.toMatchObject({
      ok: true,
      created: true,
      session: {
        providerAccountId: "account-1",
        priority: 4,
        requiredLabels: ["gpu"],
        ref: "main",
        metadata: { pr: 123 },
        type: "scheduled",
        source: "schedule",
      },
    });
  });

  it("creates a pinned resume atomically and deduplicates an active resume", async () => {
    if (!ctx.available || !ctx.storage) return;
    await ctx.storage.putCommand({
      id: "cmd-resume-concurrency",
      name: "resume concurrency",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const source: SessionRecord = {
      id: "resume-source",
      repositoryId: "repo-resume",
      prompt: "resume me",
      commandId: "cmd-resume-concurrency",
      targetLabel: "resume concurrency",
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      status: "completed",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      retryCount: 0,
      hostId: "host-1",
      concurrencyId: "resume-lock",
      cliResumeRef: "resume-ref",
    };
    await ctx.storage.putSession(source);
    await ctx.storage.putSession({
      ...source,
      id: "resume-source-without-host",
      concurrencyId: "resume-without-host-lock",
      hostId: null,
    });
    const { plane } = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      idFactory: () => "resumed-session",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    await plane.hydrateFromStorage();

    await expect(plane.resumeSessionDurable("missing")).resolves.toEqual({
      ok: false,
      error: "session not found",
    });
    await expect(plane.resumeSessionDurable("resume-source-without-host")).resolves.toEqual({
      ok: false,
      error: "source session has no agent to pin",
    });
    const resumed = await plane.resumeSessionDurable(source.id, {
      pinExpiresAt: "2026-02-01T00:00:00.000Z",
    });
    expect(resumed).toMatchObject({
      ok: true,
      created: true,
      session: {
        id: "resumed-session",
        pinnedHostId: "host-1",
        resumedFromSessionId: source.id,
        cliResumeRef: "resume-ref",
        pinExpiresAt: "2026-02-01T00:00:00.000Z",
      },
    });
    await expect(plane.resumeSessionDurable(source.id)).resolves.toMatchObject({
      ok: true,
      created: false,
      session: { id: "resumed-session" },
    });
  });
});
