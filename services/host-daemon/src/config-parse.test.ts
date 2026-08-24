import { describe, expect, it } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import { valid } from "./config-test-helpers.ts";

describe("parseDaemonConfig", () => {
  it("parses a valid config", () => {
    const config = parseDaemonConfig({
      ...valid,
      setupScript: "source ~/.zshrc",
      apiUrl: "wss://example/ws",
      apiKey: "hns_x",
    });
    expect(config.hostId).toBe("local-1");
    expect(config.apiUrl).toBe("wss://example/ws");
    expect(config.apiKey).toBe("hns_x");
    expect(config.setupScript).toBe("source ~/.zshrc");
    expect(config.repositories[0]?.worktrees[0]?.labels).toEqual(["codex"]);
  });

  it("defaults branch when not given", () => {
    const config = parseDaemonConfig({
      hostId: "x",
      repositories: [
        {
          id: "r",
          path: "/r",
          worktrees: [{ id: "w", name: "w", path: "/r/w", labels: [] }],
        },
      ],
    });
    expect(config.repositories[0]?.defaultBranch).toBe("main");
  });

  it("rejects requirements that cannot fit in one runtime report", () => {
    expect(() =>
      parseDaemonConfig({
        hostId: "x",
        requiredEnvironment: Array.from({ length: 256 }, (_, index) => `HOST_${index}`),
        repositories: [
          {
            id: "r",
            path: "/r",
            requiredEnvironment: ["REPOSITORY"],
            worktrees: [],
          },
        ],
      }),
    ).toThrow("must contain at most 256 distinct names");
  });

  it("parses repository and worktree provider-account overrides", () => {
    const config = parseDaemonConfig({
      ...valid,
      repositories: [
        {
          ...valid.repositories[0],
          providerAccountOverrides: { "account-1": { enabled: false } },
          worktrees: [
            {
              ...valid.repositories[0]!.worktrees[0],
              providerAccountOverrides: { "account-1": { commandId: "command-1" } },
            },
          ],
        },
      ],
    });
    expect(config.repositories[0]?.providerAccountOverrides).toEqual({
      "account-1": { enabled: false },
    });
    expect(config.repositories[0]?.worktrees[0]?.providerAccountOverrides).toEqual({
      "account-1": { commandId: "command-1" },
    });
  });

  it("rejects empty repositories", () => {
    expect(() => parseDaemonConfig({ hostId: "x", repositories: [] })).toThrow(/repositories/);
    expect(() => parseDaemonConfig({ hostId: "x" })).toThrow("repositories must be an array");
  });

  it("rejects a non-object root", () => {
    expect(() => parseDaemonConfig(null)).toThrow(/object/);
  });

  it("rejects invalid worktree and repo fields", () => {
    expect(() => parseDaemonConfig({ ...valid, setupScript: 1 })).toThrow(/setupScript/);
    expect(() =>
      parseDaemonConfig({
        hostId: "x",
        repositories: [{ id: "r", path: "/r", worktrees: "x" }],
      }),
    ).toThrow(/worktrees/);
    expect(() =>
      parseDaemonConfig({
        hostId: "x",
        repositories: [
          {
            id: "r",
            path: "/r",
            worktrees: [{ id: "w", name: "w", path: "/w", labels: "x" }],
          },
        ],
      }),
    ).toThrow(/labels/);
    expect(() =>
      parseDaemonConfig({
        hostId: "x",
        repositories: [null],
      }),
    ).toThrow(/object/);
    expect(() =>
      parseDaemonConfig({
        hostId: "x",
        repositories: [
          {
            id: "r",
            path: "/r",
            setupScript: 1,
            worktrees: [{ id: "w", name: "w", path: "/w", labels: [] }],
          },
        ],
      }),
    ).toThrow(/setupScript/);
    expect(() =>
      parseDaemonConfig({
        hostId: "x",
        repositories: [
          {
            id: "r",
            path: "/r",
            terminalHookScript: 1,
            worktrees: [{ id: "w", name: "w", path: "/w", labels: [] }],
          },
        ],
      }),
    ).toThrow(/terminalHookScript/);
    expect(() =>
      parseDaemonConfig({
        hostId: "x",
        repositories: [
          {
            id: "r",
            path: "/r",
            worktrees: [{ id: "w", name: "w", path: "/w", labels: [], setupScript: 1 }],
          },
        ],
      }),
    ).toThrow(/setupScript/);
    expect(() =>
      parseDaemonConfig({
        hostId: "x",
        repositories: [
          {
            id: "r",
            path: "/r",
            worktrees: [null],
          },
        ],
      }),
    ).toThrow(/invalid/);
  });

  it("rejects foreign Windows terminal-hook paths on non-Windows hosts", () => {
    if (process.platform === "win32") return;
    for (const terminalHookScript of ["C:\\hooks\\done.cmd", "\\\\server\\share\\done.cmd"]) {
      expect(() =>
        parseDaemonConfig({
          hostId: "x",
          repositories: [{ id: "r", path: "/r", terminalHookScript, worktrees: [] }],
        }),
      ).toThrow(/terminalHookScript is not valid/);
    }
  });
});
