/* eslint-disable max-lines -- authoritative cross-plane scenarios share one storage fixture. */
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createAuthoritativeReadStorage } from "./control-plane-authoritative-read-test-helpers.ts";

const now = () => "2026-01-01T00:00:00.000Z";

function options(storage: never) {
  return {
    storage,
    now,
    repositoryIdFactory: () => "repository",
    scheduleIdFactory: () => "schedule",
    commandIdFactory: () => "command",
    providerIdFactory: () => "provider",
    providerAccountIdFactory: () => "account",
    idFactory: () => "session",
    shardCount: 1,
  };
}

describe("authoritative durable reads", () => {
  it("keeps legacy command names readable and permits non-name updates", async () => {
    const storage = createAuthoritativeReadStorage();
    const legacyCommand = (id: string, name: string) => ({
      id,
      name,
      argv: ["echo"],
      appendPrompt: true,
      appendPromptSeparator: false,
      providerId: null,
      createdAt: now(),
      updatedAt: now(),
    });
    await storage.putCommand(legacyCommand("invalid", "Legacy Name"));
    await storage.putCommand(legacyCommand("duplicate-a", "duplicate"));
    await storage.putCommand(legacyCommand("duplicate-b", "duplicate"));

    const plane = new ControlPlane(options(storage));
    await expect(plane.listCommandsDurable()).resolves.toHaveLength(3);
    await expect(
      plane.updateCommandDurable("invalid", { name: "Legacy Name", appendPrompt: false }),
    ).resolves.toMatchObject({ ok: true, command: { name: "Legacy Name", appendPrompt: false } });
    await expect(
      plane.updateCommandDurable("duplicate-b", {
        name: "duplicate",
        argv: ["echo", "updated"],
      }),
    ).resolves.toMatchObject({
      ok: true,
      command: { name: "duplicate", argv: ["echo", "updated"] },
    });
  });

  it("validates command names against the authoritative durable catalog", async () => {
    const storage = createAuthoritativeReadStorage();
    const writer = new ControlPlane(options(storage));
    const reader = new ControlPlane(options(storage));

    expect(
      (
        await writer.createCommandDurable({
          id: "command-a",
          name: "shared-name",
          argv: ["echo"],
        })
      ).ok,
    ).toBe(true);
    await expect(
      reader.createCommandDurable({
        id: "command-b",
        name: "shared-name",
        argv: ["echo"],
      }),
    ).resolves.toEqual({
      ok: false,
      error: "command name already in use: shared-name",
    });

    expect(
      (
        await writer.createCommandDurable({
          id: "command-b",
          name: "other-name",
          argv: ["echo"],
        })
      ).ok,
    ).toBe(true);
    await expect(
      reader.updateCommandDurable("command-b", { name: "shared-name" }),
    ).resolves.toEqual({
      ok: false,
      error: "command name already in use: shared-name",
    });
    await expect(
      reader.updateCommandDurable("command-b", { name: "other-name" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("retains activation cutoffs and consumes stale cursors in the shared storage fake", async () => {
    const storage = createAuthoritativeReadStorage() as unknown as {
      putRepository(record: Record<string, unknown>): Promise<void>;
      putSchedule(record: Record<string, unknown>): Promise<void>;
      setRepositoryAdmissionState(
        id: string,
        state: string,
        now: string,
        activationCutoffAt?: string,
      ): Promise<Record<string, unknown> | null>;
      skipScheduleBeforeActivationCutoff(opts: Record<string, string>): Promise<boolean>;
      getSchedule(id: string): Promise<Record<string, unknown> | null>;
    };
    await storage.putRepository({
      id: "repo",
      admissionState: "paused",
      createdAt: now(),
      updatedAt: now(),
    });
    await storage.putSchedule({
      id: "schedule",
      repositoryId: "repo",
      enabled: true,
      nextRunAt: "2026-01-01T00:01:00.000Z",
    });
    await expect(
      storage.setRepositoryAdmissionState(
        "repo",
        "active",
        "2026-01-01T00:02:00.000Z",
        "2026-01-01T00:02:00.000Z",
      ),
    ).resolves.toMatchObject({ activationCutoffAt: "2026-01-01T00:02:00.000Z" });
    await expect(
      storage.skipScheduleBeforeActivationCutoff({
        scheduleId: "schedule",
        repositoryId: "repo",
        activationCutoffAt: "2026-01-01T00:02:00.000Z",
        expectedNextRunAt: "2026-01-01T00:01:00.000Z",
        newNextRunAt: "2026-01-01T00:03:00.000Z",
      }),
    ).resolves.toBe(true);
    expect((await storage.getSchedule("schedule"))?.nextRunAt).toBe("2026-01-01T00:03:00.000Z");
  });

  it("refreshes a stale closed admission cache before durable session creation", async () => {
    const storage = createAuthoritativeReadStorage();
    const writer = new ControlPlane(options(storage));
    const reader = new ControlPlane(options(storage));
    expect(
      (await writer.createRepositoryDurable({ name: "repository", url: "https://example.test/r" }))
        .ok,
    ).toBe(true);
    expect((await writer.createCommandDurable({ name: "command", argv: ["echo"] })).ok).toBe(true);
    const durable = storage as unknown as {
      getRepository(id: string): Promise<Record<string, unknown> | null>;
      putRepository(record: Record<string, unknown>): Promise<void>;
    };
    const repository = await durable.getRepository("repository");
    if (!repository) throw new Error("repository not created");
    await durable.putRepository({ ...repository, admissionState: "paused" });
    expect(await reader.getRepositoryDurable("repository")).toMatchObject({
      admissionState: "paused",
    });
    await durable.putRepository({ ...repository, admissionState: "active" });

    await expect(
      reader.createSessionDurable({
        repositoryId: "repository",
        prompt: "work",
        target: { commandId: "command" },
        timeout: 1,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("shows another control plane's writes, updates, deletes, sessions, and ordered logs", async () => {
    const storage = createAuthoritativeReadStorage();
    const writer = new ControlPlane(options(storage));
    const reader = new ControlPlane(options(storage));
    expect(
      (await writer.createRepositoryDurable({ name: "repository", url: "https://example.test/r" }))
        .ok,
    ).toBe(true);
    expect((await writer.createCommandDurable({ name: "command", argv: ["echo"] })).ok).toBe(true);
    expect((await writer.createProviderDurable({ name: "provider" })).ok).toBe(true);
    expect(
      (
        await writer.createProviderAccountDurable({
          providerId: "provider",
          label: "account@example.test",
        })
      ).ok,
    ).toBe(true);
    expect(
      (await writer.putHostInventoryDurable("host", { repositories: [], commandProfiles: {} })).ok,
    ).toBe(true);
    expect(
      (
        await writer.putScheduleDurable({
          repositoryId: "repository",
          name: "schedule",
          target: { commandId: "command" },
          cron: "* * * * *",
          timeout: 1,
          nextRunAt: now(),
        })
      ).ok,
    ).toBe(true);

    expect(await reader.getRepositoryDurable("repository")).toMatchObject({ name: "repository" });
    expect(await reader.getCommandDurable("command")).toMatchObject({ name: "command" });
    expect(await reader.getProviderDurable("provider")).toMatchObject({ name: "provider" });
    expect(await reader.getProviderAccountDurable("account")).toMatchObject({
      label: "account@example.test",
    });
    expect((await reader.listHostInventoriesDurable()).map((host) => host.hostId)).toEqual([
      "host",
    ]);
    expect(await reader.getScheduleDurable("schedule")).toMatchObject({ name: "schedule" });
    expect(reader.listSessionTargets()).toHaveLength(2);

    expect(
      (
        await writer.createSessionDurable({
          repositoryId: "repository",
          prompt: "work",
          target: { commandId: "command" },
          timeout: 1,
        })
      ).ok,
    ).toBe(true);
    await writer.handleHostMessageDurable({
      type: "session:log",
      sessionId: "session",
      attemptId: "a",
      stream: "stdout",
      content: "second",
      timestamp: now(),
      seq: 2,
    });
    await writer.handleHostMessageDurable({
      type: "session:log",
      sessionId: "session",
      attemptId: "a",
      stream: "stdout",
      content: "first",
      timestamp: now(),
      seq: 1,
    });
    writer.seedWorktree({
      id: "worktree",
      name: "worktree",
      hostId: "host",
      repositoryId: "repository",
      path: "/worktree",
      labels: [],
      status: "idle",
      online: true,
    });
    expect((await writer.archiveSessionLogs("session")).key).toContain("session/logs.jsonl");
    await writer.settleStorage();
    expect(await reader.getSessionDurable("session")).toMatchObject({ prompt: "work" });
    expect((await reader.listSessionsPageDurable()).items.map((session) => session.id)).toEqual([
      "session",
    ]);
    expect((await reader.getLogsDurable("session")).map((record) => record.content)).toEqual([
      "first",
      "second",
    ]);

    const restarted = new ControlPlane(options(storage));
    await restarted.hydrateFromStorage();
    expect(restarted.getLogs("session").map((record) => record.content)).toEqual([
      "first",
      "second",
    ]);
    expect(
      (await restarted.getLogsDurable("session", { stream: "stdout", limit: 1 })).map(
        (record) => record.content,
      ),
    ).toEqual(["first"]);
    expect(restarted.getWorktree("worktree")?.path).toBe("/worktree");
    expect(restarted.getArchive("session")).toMatchObject({
      status: "complete",
      objectStored: false,
    });
    expect((await reader.updateRepositoryDurable("repository", { name: "renamed" })).ok).toBe(true);
    expect((await writer.getRepositoryDurable("repository"))?.name).toBe("renamed");
    expect((await reader.deleteHostInventoryDurable("host")).ok).toBe(true);
    expect(await writer.getHostInventoryDurable("host")).toBeNull();
    expect((await reader.deleteScheduleDurable("schedule")).ok).toBe(true);
    expect(await writer.getScheduleDurable("schedule")).toBeNull();
  });

  it("evaluates a schedule written by another control plane without full rehydration", async () => {
    const storage = createAuthoritativeReadStorage();
    const writer = new ControlPlane(options(storage));
    const scheduler = new ControlPlane(options(storage));
    expect(
      (await writer.createRepositoryDurable({ name: "repository", url: "https://example.test/r" }))
        .ok,
    ).toBe(true);
    expect((await writer.createCommandDurable({ name: "command", argv: ["echo"] })).ok).toBe(true);
    expect(
      (
        await writer.putScheduleDurable({
          repositoryId: "repository",
          principalId: "principal",
          name: "schedule",
          target: { commandId: "command" },
          cron: "* * * * *",
          timeout: 1,
          nextRunAt: now(),
        })
      ).ok,
    ).toBe(true);

    expect(
      (await scheduler.evaluateCronDurable("2026-01-01T00:01:00.000Z")).map(
        (session) => session.id,
      ),
    ).toEqual(["session"]);
  });
});
