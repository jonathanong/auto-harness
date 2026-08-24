import { describe, expect, it } from "vitest";

import { registerHostDurable } from "./control-plane-agents.ts";
import { ControlPlane } from "./control-plane.ts";

describe("durable host inventory registration fence", () => {
  it("rolls back when the inventory lease fence loses", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "c" });
    const calls: string[] = [];
    plane.state.storage = {
      tryRegisterHost: async () => true,
      getHostInventory: async () => null,
      listWorktreesByHost: async () => [],
      putHostInventoryFenced: async () => ({ ok: false, reason: "lease" as const }),
      releaseHostConnection: async (_hostId: string, connectionId: string) => (
        calls.push(connectionId), true
      ),
      getHostLock: async () => null,
    } as never;

    await expect(
      plane.registerHostDurable({
        hostId: "h",
        worktrees: [],
        commandProfiles: [],
        replaceExisting: true,
      }),
    ).resolves.toEqual({ ok: false, error: "host connection changed while publishing inventory" });
    expect(calls).toEqual(["c"]);
  });

  it("retries a version conflict by re-reading and rebuilding against the current document", async () => {
    // A concurrent UI edit committed a newer version between registration's initial read
    // and its fenced write. The retry must re-read the now-current document — not just
    // resend the stale one with a bumped version number — so the edit survives.
    const edited = {
      hostId: "h",
      repositories: [],
      providerAccounts: [{ providerAccountId: "account-added-by-edit" }],
      commandProfiles: {},
      updatedAt: "2026-08-15T00:00:01.000Z",
      version: 2,
    };
    const putCalls: Array<{
      version?: number;
      providerAccounts: Array<{ providerAccountId: string }>;
    }> = [];
    const plane = new ControlPlane({ connectionIdFactory: () => "c" });
    plane.state.storage = {
      tryRegisterHost: async () => true,
      getHostInventory: async () => (putCalls.length === 0 ? null : edited),
      listWorktreesByHost: async () => [],
      putHostInventoryFenced: async (rec: {
        version?: number;
        providerAccounts: Array<{ providerAccountId: string }>;
      }) => {
        putCalls.push(rec);
        return putCalls.length === 1
          ? { ok: false as const, reason: "version" as const }
          : { ok: true as const };
      },
      releaseHostConnection: async () => true,
      getHostLock: async () => null,
    } as never;

    await expect(
      plane.registerHostDurable({
        hostId: "h",
        worktrees: [],
        commandProfiles: [],
        replaceExisting: true,
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(putCalls).toHaveLength(2);
    // The first attempt read `previous: null`, so its document has no provider accounts
    // and version 1. The retry re-reads `edited` (version 2, one provider account) and
    // rebuilds against it — proof by the version advancing to 3 and the account
    // surviving, not by resending the first attempt's stale, now-conflicting document.
    expect(putCalls[0]).toMatchObject({ version: 1, providerAccounts: [] });
    expect(putCalls[1]).toMatchObject({
      version: 3,
      providerAccounts: [{ providerAccountId: "account-added-by-edit" }],
    });
  });

  it("gives up and rolls back after repeated version conflicts rather than retrying forever", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "c" });
    const released: string[] = [];
    plane.state.storage = {
      tryRegisterHost: async () => true,
      getHostInventory: async () => null,
      listWorktreesByHost: async () => [],
      putHostInventoryFenced: async () => ({ ok: false as const, reason: "version" as const }),
      releaseHostConnection: async (_hostId: string, connectionId: string) => (
        released.push(connectionId), true
      ),
      getHostLock: async () => null,
    } as never;

    await expect(
      plane.registerHostDurable({
        hostId: "h",
        worktrees: [],
        commandProfiles: [],
        replaceExisting: true,
      }),
    ).resolves.toEqual({
      ok: false,
      error: "host inventory changed while publishing registration",
    });
    expect(released).toEqual(["c"]);
  });

  it("rolls back when the authoritative inventory read fails", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "c" });
    plane.state.storage = {
      tryRegisterHost: async () => true,
      getHostInventory: async () => {
        throw new Error("read");
      },
      listWorktreesByHost: async () => [],
      releaseHostConnection: async () => true,
      getHostLock: async () => null,
    } as never;

    await expect(
      plane.registerHostDurable({
        hostId: "h",
        worktrees: [],
        commandProfiles: [],
        replaceExisting: true,
      }),
    ).rejects.toThrow("read");
  });

  it("rejects an invalid runtime report on the durable path", async () => {
    const plane = new ControlPlane();
    plane.state.storage = { getSession: async () => null } as never;
    await expect(
      registerHostDurable(plane.state, {
        hostId: "h",
        worktrees: [],
        runtime: {
          daemonVersion: "test",
          gitVersion: "2.36.0",
          gitReady: true,
          environmentNames: Array.from({ length: 513 }, (_, index) => `TOKEN_${index}`),
        },
      }),
    ).resolves.toEqual({ ok: false, error: "runtime report is invalid" });
  });

  it("rolls back when a worktree fence loses during durable registration", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "c" });
    plane.state.storage = {
      tryRegisterHost: async () => true,
      getHostInventory: async () => null,
      getWorktree: async () => null,
      listWorktreesByHost: async () => [],
      putWorktreeFenced: async () => false,
      releaseHostConnection: async () => true,
      getHostLock: async () => null,
    } as never;
    await expect(
      plane.registerHostDurable({
        hostId: "h",
        worktrees: [{ id: "w", name: "w", repositoryId: "r", path: "/w", labels: [] }],
        replaceExisting: true,
      }),
    ).resolves.toEqual({
      ok: false,
      error: "host connection changed while publishing inventory",
    });
  });

  it("rejects duplicate durable runningAttempts before taking a lease", async () => {
    const plane = new ControlPlane();
    plane.state.storage = { tryRegisterHost: async () => true } as never;
    await expect(
      registerHostDurable(plane.state, {
        hostId: "h",
        worktrees: [],
        runningAttempts: [
          { sessionId: "s", attemptId: "a" },
          { sessionId: "s", attemptId: "b" },
        ],
      }),
    ).resolves.toEqual({ ok: false, error: expect.stringMatching(/duplicate/) });
  });

  it("registers a durable host without protocolVersion", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "c" });
    plane.state.storage = {
      tryRegisterHost: async () => true,
      getHostInventory: async () => null,
      getWorktree: async () => null,
      listWorktreesByHost: async () => [],
      putWorktreeFenced: async () => true,
      putHostInventoryFenced: async () => ({ ok: true }),
    } as never;
    await expect(
      registerHostDurable(plane.state, {
        hostId: "h",
        worktrees: [],
      }),
    ).resolves.toEqual({ ok: true, connectionId: "c" });
    expect(plane.state.connections.get("c")?.protocolVersion).toBeUndefined();
  });
});
