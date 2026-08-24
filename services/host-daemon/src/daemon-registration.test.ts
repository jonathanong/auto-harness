import { describe, expect, it } from "vitest";

import { applyDaemonInventory, registerDaemon } from "./daemon-registration.ts";
import { parseExecutionProfiles } from "./execution-profiles.ts";

describe("daemon registration", () => {
  it("omits optional identity and runtime while preserving drain intent", async () => {
    const messages: unknown[] = [];
    await registerDaemon(
      { hostId: "host", repositories: [], providerAccounts: [] },
      { send: async (message: unknown) => void messages.push(message) } as never,
      [],
      true,
    );
    expect(messages).toEqual([expect.objectContaining({ draining: true, runningSessions: [] })]);
    expect(messages[0]).not.toHaveProperty("daemonInstanceId");
    expect(messages[0]).not.toHaveProperty("runtime");
  });

  it("publishes sorted running sessions and all configured inventory", async () => {
    const messages: unknown[] = [];
    await registerDaemon(
      {
        hostId: "h",
        repositories: [
          {
            id: "r",
            path: "/repo",
            defaultBranch: "main",
            worktrees: [{ id: "w", name: "name", path: "/wt", labels: ["l"] }],
          },
        ],
        providerAccounts: [],
      },
      { send: async (message: unknown) => void messages.push(message) } as never,
      ["z", "a"],
      false,
      {
        instanceId: "123e4567-e89b-42d3-a456-426614174000",
        startedAt: "2026-08-11T00:00:00.000Z",
      },
      { daemonVersion: "0.0.0", gitVersion: "2.36.0", gitReady: true },
      [
        { sessionId: "z", attemptId: "2" },
        { sessionId: "a", attemptId: "b" },
        { sessionId: "a", attemptId: "a" },
      ],
    );
    expect(messages).toEqual([
      expect.objectContaining({
        type: "host:register",
        hostId: "h",
        capabilities: {
          features: ["scheduled-main-checkout"],
          maxConcurrentAssignments: 64,
        },
        providerAccountReadiness: [],
        repositories: [{ id: "r", path: "/repo", defaultBranch: "main" }],
        protocolVersion: 1,
        runningSessions: ["a", "z"],
        runningAttempts: [
          { sessionId: "a", attemptId: "a" },
          { sessionId: "a", attemptId: "b" },
          { sessionId: "z", attemptId: "2" },
        ],
        daemonInstanceId: "123e4567-e89b-42d3-a456-426614174000",
        daemonStartedAt: "2026-08-11T00:00:00.000Z",
        runtime: { daemonVersion: "0.0.0", gitVersion: "2.36.0", gitReady: true },
        worktrees: [expect.objectContaining({ id: "w", repositoryId: "r" })],
      }),
    ]);
  });

  it("advertises opaque readiness for local execution profiles", async () => {
    const messages: unknown[] = [];
    const profiles = parseExecutionProfiles({
      maxConcurrentAssignments: 2,
      accounts: { acct: { home: "/homes/acct" } },
    });
    await registerDaemon(
      { hostId: "h", repositories: [], providerAccounts: [] },
      { send: async (message: unknown) => void messages.push(message) } as never,
      [],
      false,
      undefined,
      undefined,
      [],
      profiles,
    );
    expect(messages[0]).toMatchObject({
      capabilities: { features: ["scheduled-main-checkout"], maxConcurrentAssignments: 2 },
      providerAccountReadiness: [
        expect.objectContaining({ providerAccountId: "acct", ready: false }),
      ],
    });
    expect(JSON.stringify(messages[0])).not.toContain("/homes/acct");
  });

  it("applies the next repositories, ensures worktrees, then registers", async () => {
    const config = { hostId: "h", repositories: [], providerAccounts: [] };
    const next = {
      ...config,
      setupScript: "source ~/.zshrc",
      repositories: [{ id: "p", path: "/p", defaultBranch: "main", worktrees: [] }],
    };
    const calls: string[] = [];
    await applyDaemonInventory(
      config,
      next,
      { ensureAll: async () => void calls.push("ensure") } as never,
      async () => void calls.push("register"),
    );
    expect(config.repositories).toEqual(next.repositories);
    expect(config).toMatchObject({ setupScript: "source ~/.zshrc" });
    expect(calls).toEqual(["ensure", "register"]);
  });

  it("removes a host setup script when the next inventory omits it", async () => {
    const config = {
      hostId: "h",
      setupScript: "source ~/.zshrc",
      repositories: [],
      providerAccounts: [],
    };
    const next = { hostId: "h", repositories: [], providerAccounts: [] };
    await applyDaemonInventory(
      config,
      next,
      { ensureAll: async () => undefined } as never,
      async () => undefined,
    );
    expect(config).not.toHaveProperty("setupScript");
  });

  it("restores the prior inventory when preparation fails", async () => {
    const config = {
      hostId: "h",
      setupScript: "old setup",
      repositories: [{ id: "old", path: "/old", defaultBranch: "main", worktrees: [] }],
      providerAccounts: [],
    };
    const next = {
      ...config,
      setupScript: "new setup",
      repositories: [{ id: "next", path: "/next", defaultBranch: "main", worktrees: [] }],
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
    expect(config.setupScript).toBe("old setup");
  });

  it("restores the prior inventory when registration fails", async () => {
    const config = { hostId: "h", repositories: [], providerAccounts: [] };
    const next = {
      ...config,
      setupScript: "new setup",
      repositories: [{ id: "next", path: "/next", defaultBranch: "main", worktrees: [] }],
    };

    await expect(
      applyDaemonInventory(config, next, { ensureAll: async () => {} } as never, async () => {
        throw new Error("registration failed");
      }),
    ).rejects.toThrow("registration failed");
    expect(config.repositories).toEqual([]);
    expect(config).not.toHaveProperty("setupScript");
  });
});
