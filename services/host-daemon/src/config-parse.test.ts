import { describe, expect, it } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import { valid } from "./config-test-helpers.ts";

describe("parseDaemonConfig", () => {
  it("parses a valid config", () => {
    const config = parseDaemonConfig({
      ...valid,
      apiUrl: "wss://example/ws",
      apiKey: "hns_x",
      logLevel: "warn",
    });
    expect(config.hostId).toBe("local-1");
    expect(config.apiUrl).toBe("wss://example/ws");
    expect(config.apiKey).toBe("hns_x");
    expect(config.logLevel).toBe("warn");
    expect(config.commandProfiles["echo-prompt"]?.argv).toEqual(["echo"]);
    expect(config.repositories[0]?.worktrees[0]?.labels).toEqual(["codex"]);
  });

  it("defaults branch and log level", () => {
    const config = parseDaemonConfig({
      hostId: "x",
      logLevel: "nope",
      repositories: [
        {
          id: "r",
          path: "/r",
          worktrees: [{ id: "w", name: "w", path: "/r/w", labels: [] }],
        },
      ],
    });
    expect(config.repositories[0]?.defaultBranch).toBe("main");
    expect(config.logLevel).toBe("info");
    expect(Object.keys(config.commandProfiles)).toEqual([]);
  });

  it("rejects empty repositories", () => {
    expect(() => parseDaemonConfig({ hostId: "x", repositories: [], commandProfiles: {} })).toThrow(
      /repositories/,
    );
  });

  it("rejects non-object root and bad profiles", () => {
    expect(() => parseDaemonConfig(null)).toThrow(/object/);
    expect(() =>
      parseDaemonConfig({
        ...valid,
        commandProfiles: { bad: { argv: [] } },
      }),
    ).toThrow(/argv/);
    expect(() =>
      parseDaemonConfig({
        ...valid,
        commandProfiles: { bad: "x" },
      }),
    ).toThrow(/object/);
    expect(() =>
      parseDaemonConfig({
        ...valid,
        commandProfiles: "nope",
      }),
    ).toThrow(/commandProfiles/);
  });

  it("rejects invalid worktree and repo fields", () => {
    expect(() =>
      parseDaemonConfig({
        hostId: "x",
        commandProfiles: {},
        repositories: [{ id: "r", path: "/r", worktrees: "x" }],
      }),
    ).toThrow(/worktrees/);
    expect(() =>
      parseDaemonConfig({
        hostId: "x",
        commandProfiles: {},
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
        commandProfiles: {},
        repositories: [null],
      }),
    ).toThrow(/object/);
    expect(() =>
      parseDaemonConfig({
        hostId: "x",
        commandProfiles: {},
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
        commandProfiles: {},
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
        commandProfiles: {},
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
        commandProfiles: {},
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
});
