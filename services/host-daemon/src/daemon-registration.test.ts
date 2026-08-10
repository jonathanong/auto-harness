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
});
