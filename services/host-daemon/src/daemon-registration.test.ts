/* eslint-disable max-lines -- registration rollback and reconnect barriers share one fixture. */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST_PROTOCOL_VERSION } from "@auto-harness/shared";
import { afterEach, describe, expect, it } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import { applyDaemonInventory, registerDaemon } from "./daemon-registration.ts";
import { parseExecutionProfiles } from "./execution-profiles.ts";
import { WorktreeManager } from "./worktree-manager.ts";
import { WorkspaceManager } from "./workspace-manager.ts";

describe("daemon registration", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

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
            id: "r2",
            path: "/repo-2",
            defaultBranch: "main",
            worktrees: [],
          },
          {
            id: "r",
            path: "/repo",
            defaultBranch: "main",
            worktrees: [{ id: "w", name: "name", path: "/wt", labels: ["l"] }],
          },
        ],
        providerAccounts: [],
        workspacePools: [
          {
            workspacePoolId: "pool",
            slots: [{ id: "slot", name: "slot", path: "/workspace/slot" }],
          },
        ],
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
          features: ["scheduled-main-checkout", "session-spawn", "workspace-sessions"],
          maxConcurrentAssignments: 64,
        },
        providerAccountReadiness: [],
        repositories: [
          { id: "r", path: "/repo", defaultBranch: "main" },
          { id: "r2", path: "/repo-2", defaultBranch: "main" },
        ],
        workspacePools: [
          {
            workspacePoolId: "pool",
            slots: [{ id: "slot", name: "slot", path: "/workspace/slot" }],
          },
        ],
        protocolVersion: HOST_PROTOCOL_VERSION,
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
      capabilities: {
        features: ["scheduled-main-checkout", "session-spawn", "workspace-sessions"],
        maxConcurrentAssignments: 2,
      },
      providerAccountReadiness: [
        expect.objectContaining({ providerAccountId: "acct", ready: false }),
      ],
    });
    expect(JSON.stringify(messages[0])).not.toContain("/homes/acct");
  });

  it("rejects a registration that cannot fit in one WebSocket frame", async () => {
    const messages: unknown[] = [];
    const profiles = parseExecutionProfiles({
      accounts: Object.fromEntries(
        Array.from({ length: 256 }, (_, index) => [
          `account-${String(index)}-${"x".repeat(500)}`,
          { home: `/homes/${String(index)}` },
        ]),
      ),
    });
    await expect(
      registerDaemon(
        { hostId: "h", repositories: [], providerAccounts: [] },
        { send: async (message: unknown) => void messages.push(message) } as never,
        [],
        false,
        undefined,
        undefined,
        [],
        profiles,
      ),
    ).rejects.toThrow(/WebSocket limit/);
    expect(messages).toEqual([]);
  });

  it("keeps the live inventory intact while validating and registering the candidate", async () => {
    const config = {
      hostId: "h",
      setupScript: "old setup",
      repositories: [{ id: "old", path: "/old", defaultBranch: "main", worktrees: [] }],
      providerAccounts: [],
    };
    const next = {
      ...config,
      setupScript: "source ~/.zshrc",
      repositories: [{ id: "p", path: "/p", defaultBranch: "main", worktrees: [] }],
    };
    const calls: string[] = [];
    await applyDaemonInventory(
      config,
      next,
      {
        ensureAll: async (candidate) => {
          calls.push("ensure");
          expect(candidate).toBe(next);
          expect(config).toMatchObject({
            setupScript: "old setup",
            repositories: [{ id: "old", path: "/old" }],
          });
        },
      } as never,
      async (candidate) => {
        calls.push("register");
        expect(candidate).toBe(next);
        expect(config.repositories).toEqual([
          { id: "old", path: "/old", defaultBranch: "main", worktrees: [] },
        ]);
      },
    );
    expect(config.repositories).toEqual(next.repositories);
    expect(config).toMatchObject({ setupScript: "source ~/.zshrc" });
    expect(calls).toEqual(["ensure", "register"]);
  });

  it("invalidates a claim completed while candidate registration is in flight", async () => {
    const config = parseDaemonConfig({
      hostId: "h",
      setupScript: "old setup",
      repositories: [
        {
          id: "repo",
          path: "/repo",
          defaultBranch: "main",
          worktrees: [{ id: "worktree", name: "worktree", path: "/repo/worktree", labels: [] }],
        },
      ],
    });
    const next = parseDaemonConfig({
      hostId: "h",
      setupScript: "new setup",
      repositories: config.repositories,
    });
    const worktrees = new WorktreeManager(config, {
      ensureRepo: async () => undefined,
      ensureWorktree: async () => undefined,
      checkoutRef: async () => undefined,
      prepareMainCheckout: async () => undefined,
      revParse: async () => "abc",
    });
    let claimed: Awaited<ReturnType<typeof worktrees.claim>> | undefined;

    await applyDaemonInventory(config, next, worktrees, async () => {
      claimed = await worktrees.claim("repo", "worktree");
      expect(claimed.hostSetupScript).toBe("old setup");
    });

    await expect(claimed!.currentExecutionTarget!()).rejects.toThrow(
      "host inventory changed after this checkout was claimed",
    );
  });

  it("blocks workspace claims for the whole candidate registration fence", async () => {
    const root = await mkdtemp(join(tmpdir(), "ah-registration-workspace-"));
    roots.push(root);
    const slot = join(root, "slot");
    await mkdir(slot);
    const config = parseDaemonConfig({
      hostId: "h",
      allowedRoots: [root],
      repositories: [],
      workspacePools: [
        { workspacePoolId: "pool", slots: [{ id: "slot", name: "slot", path: slot }] },
      ],
    });
    const next = parseDaemonConfig({
      ...config,
      workspacePools: [
        { workspacePoolId: "pool", slots: [{ id: "slot", name: "slot", path: slot }] },
      ],
    });
    const manager = new WorktreeManager(config, {
      ensureRepo: async () => undefined,
      ensureWorktree: async () => undefined,
      checkoutRef: async () => undefined,
      prepareMainCheckout: async () => undefined,
      revParse: async () => "abc",
    });
    const workspaces = new WorkspaceManager(config);
    let releaseRegistration!: () => void;
    const registrationEntered = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    let registrationStarted!: () => void;
    const registrationStartedPromise = new Promise<void>((resolve) => {
      registrationStarted = resolve;
    });

    const applying = applyDaemonInventory(
      config,
      next,
      manager,
      async () => {
        registrationStarted();
        await registrationEntered;
      },
      undefined,
      workspaces,
    );
    await registrationStartedPromise;
    await expect(workspaces.claim("pool", "slot")).rejects.toThrow(
      "host inventory update in progress",
    );
    releaseRegistration();
    await applying;
    await expect(workspaces.claim("pool", "slot")).resolves.toMatchObject({
      slot: { id: "slot" },
    });
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

    const inventoryChanges: string[] = [];
    await expect(
      applyDaemonInventory(
        config,
        next,
        {
          noteInventoryChange: () => void inventoryChanges.push("changed"),
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
    expect(inventoryChanges).toEqual(["changed", "changed"]);
  });

  it("restores the prior inventory when registration fails", async () => {
    const config = { hostId: "h", repositories: [], providerAccounts: [] };
    const next = {
      ...config,
      setupScript: "new setup",
      repositories: [{ id: "next", path: "/next", defaultBranch: "main", worktrees: [] }],
    };

    const inventoryChanges: string[] = [];
    await expect(
      applyDaemonInventory(
        config,
        next,
        {
          noteInventoryChange: () => void inventoryChanges.push("changed"),
          ensureAll: async () => {},
        } as never,
        async () => {
          throw new Error("registration failed");
        },
      ),
    ).rejects.toThrow("registration failed");
    expect(config.repositories).toEqual([]);
    expect(config).not.toHaveProperty("setupScript");
    expect(inventoryChanges).toEqual(["changed", "changed"]);
  });

  it("restores a previously configured allowed-roots policy on failure", async () => {
    const config = {
      hostId: "h",
      allowedRoots: ["/old"],
      repositories: [],
      providerAccounts: [],
    };
    const next = { ...config, allowedRoots: ["/new"] };
    await expect(
      applyDaemonInventory(
        config,
        next,
        {
          ensureAll: async () => {
            throw new Error("invalid roots");
          },
        } as never,
        async () => undefined,
      ),
    ).rejects.toThrow("invalid roots");
    expect(config.allowedRoots).toEqual(["/old"]);
  });

  it("rolls back a newly applied workspace inventory when its post-apply hook fails", async () => {
    const config = { hostId: "h", repositories: [], providerAccounts: [] };
    const next = {
      ...config,
      workspacePools: [
        {
          workspacePoolId: "pool",
          slots: [{ id: "slot", name: "slot", path: "/workspace/slot" }],
        },
      ],
    };
    const workspaceChanges: string[] = [];

    await expect(
      applyDaemonInventory(
        config,
        next,
        { ensureAll: async () => undefined, noteInventoryChange: () => undefined } as never,
        async () => undefined,
        () => {
          throw new Error("post-apply failed");
        },
        {
          ensureAll: async (candidate) => expect(candidate).toBe(next),
          noteInventoryChange: () => void workspaceChanges.push("changed"),
        } as never,
      ),
    ).rejects.toThrow("post-apply failed");

    expect(config).not.toHaveProperty("workspacePools");
    expect(workspaceChanges).toEqual(["changed", "changed"]);
  });

  it("restores an existing workspace inventory after registration fails", async () => {
    const workspacePools = [
      {
        workspacePoolId: "old-pool",
        slots: [{ id: "old-slot", name: "old", path: "/workspace/old" }],
      },
    ];
    const config = { hostId: "h", repositories: [], providerAccounts: [], workspacePools };
    const next = { hostId: "h", repositories: [], providerAccounts: [] };

    await expect(
      applyDaemonInventory(
        config,
        next,
        { ensureAll: async () => undefined, noteInventoryChange: () => undefined } as never,
        async () => {
          throw new Error("registration failed");
        },
        undefined,
        { ensureAll: async () => undefined, noteInventoryChange: () => undefined } as never,
      ),
    ).rejects.toThrow("registration failed");
    expect(config.workspacePools).toEqual(workspacePools);
  });

  it("commits host setup cache inputs into the live inventory", async () => {
    const config = {
      hostId: "h",
      setupCacheInputs: ["old.lock"],
      repositories: [],
      providerAccounts: [],
    };
    const next = { ...config, setupCacheInputs: ["new.lock"] };
    await applyDaemonInventory(
      config,
      next,
      { ensureAll: async () => undefined } as never,
      async () => undefined,
    );
    expect(config.setupCacheInputs).toEqual(["new.lock"]);
    await applyDaemonInventory(
      config,
      { hostId: "h", repositories: [], providerAccounts: [] },
      { ensureAll: async () => undefined } as never,
      async () => undefined,
    );
    expect(config).not.toHaveProperty("setupCacheInputs");
  });

  it("restores host setup cache inputs when registration fails", async () => {
    const config = {
      hostId: "h",
      setupCacheInputs: ["old.lock"],
      repositories: [],
      providerAccounts: [],
    };
    await expect(
      applyDaemonInventory(
        config,
        { ...config, setupCacheInputs: ["new.lock"] },
        { ensureAll: async () => undefined } as never,
        async () => {
          throw new Error("registration failed");
        },
      ),
    ).rejects.toThrow("registration failed");
    expect(config.setupCacheInputs).toEqual(["old.lock"]);
  });

  it("does not keep newly applied setup cache inputs after registration fails", async () => {
    const config = { hostId: "h", repositories: [], providerAccounts: [] };
    await expect(
      applyDaemonInventory(
        config,
        { ...config, setupCacheInputs: ["new.lock"] },
        { ensureAll: async () => undefined } as never,
        async () => {
          throw new Error("registration failed");
        },
      ),
    ).rejects.toThrow("registration failed");
    expect(config).not.toHaveProperty("setupCacheInputs");
  });
});
