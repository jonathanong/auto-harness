import { describe, expect, it } from "vitest";

import { applyDaemonInventory, registerDaemon } from "./daemon-registration.ts";

describe("daemon registration", () => {
  it("publishes sorted running sessions and all configured inventory", async () => {
    const messages: unknown[] = [];
    await registerDaemon(
      {
        hostId: "h",
        logLevel: "info",
        repositories: [
          {
            id: "r",
            path: "/repo",
            defaultBranch: "main",
            worktrees: [{ id: "w", name: "name", path: "/wt", labels: ["l"] }],
          },
        ],
        providerAccounts: [],
        commandProfiles: { z: { argv: ["z"] }, a: { argv: ["a"] } },
      },
      { send: async (message: unknown) => void messages.push(message) } as never,
      ["z", "a"],
    );
    expect(messages).toEqual([
      expect.objectContaining({
        type: "host:register",
        hostId: "h",
        capabilities: ["scheduled-main-checkout"],
        repositories: [{ id: "r", path: "/repo", defaultBranch: "main" }],
        commandProfiles: ["a", "z"],
        runningSessions: ["a", "z"],
        worktrees: [expect.objectContaining({ id: "w", repositoryId: "r" })],
      }),
    ]);
  });

  it("applies optional inventory settings, ensures worktrees, then registers", async () => {
    const config = {
      hostId: "h",
      logLevel: "info" as const,
      repositories: [],
      providerAccounts: [],
      commandProfiles: {},
    };
    const next = { ...config, logLevel: "debug" as const, commandProfiles: { p: { argv: ["p"] } } };
    const calls: string[] = [];
    await applyDaemonInventory(
      config,
      next,
      { ensureAll: async () => void calls.push("ensure") } as never,
      async () => void calls.push("register"),
    );
    expect(config.logLevel).toBe("debug");
    expect(config.commandProfiles).toEqual(next.commandProfiles);
    expect(calls).toEqual(["ensure", "register"]);
  });

  it("restores the prior inventory when preparation fails", async () => {
    const config = {
      hostId: "h",
      logLevel: "info" as const,
      repositories: [{ id: "old", path: "/old", defaultBranch: "main", worktrees: [] }],
      providerAccounts: [],
      commandProfiles: { old: { argv: ["old"] } },
    };
    const next = {
      ...config,
      logLevel: "debug" as const,
      repositories: [{ id: "next", path: "/next", defaultBranch: "main", worktrees: [] }],
      commandProfiles: { next: { argv: ["next"] } },
    };

    await expect(
      applyDaemonInventory(
        config,
        next,
        {
          ensureAll: async () => {
            throw new Error("worktree preparation failed");
          },
        } as never,
        async () => {},
      ),
    ).rejects.toThrow("worktree preparation failed");
    expect(config.repositories).toEqual([
      { id: "old", path: "/old", defaultBranch: "main", worktrees: [] },
    ]);
    expect(config.commandProfiles).toEqual({ old: { argv: ["old"] } });
    expect(config.logLevel).toBe("info");
  });

  it("restores the prior inventory when registration fails", async () => {
    const config = {
      hostId: "h",
      logLevel: "info" as const,
      repositories: [],
      providerAccounts: [],
      commandProfiles: {},
    };
    const next = {
      ...config,
      logLevel: "debug" as const,
      commandProfiles: { next: { argv: ["next"] } },
    };

    await expect(
      applyDaemonInventory(config, next, { ensureAll: async () => {} } as never, async () => {
        throw new Error("registration failed");
      }),
    ).rejects.toThrow("registration failed");
    expect(config.repositories).toEqual([]);
    expect(config.commandProfiles).toEqual({});
    expect(config.logLevel).toBe("info");
  });
});
