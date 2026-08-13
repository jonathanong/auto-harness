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
      stream: "stdout",
      content: "second",
      timestamp: now(),
      seq: 2,
    });
    await writer.handleHostMessageDurable({
      type: "session:log",
      sessionId: "session",
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
    expect((await writer.createCommandDurable({ name: "command", argv: ["echo"] })).ok).toBe(true);
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

    expect(
      (await scheduler.evaluateCronDurable("2026-01-01T00:01:00.000Z")).map(
        (session) => session.id,
      ),
    ).toEqual(["session"]);
  });
});
