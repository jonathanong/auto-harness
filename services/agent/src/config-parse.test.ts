import { describe, expect, it } from "vitest";

import { parseAgentConfig } from "./config.ts";
import { valid } from "./config-test-helpers.ts";

describe("parseAgentConfig", () => {
  it("parses a valid config", () => {
    const config = parseAgentConfig({
      ...valid,
      apiUrl: "wss://example/ws",
      apiKey: "hns_x",
      logLevel: "warn",
    });
    expect(config.agentId).toBe("local-1");
    expect(config.apiUrl).toBe("wss://example/ws");
    expect(config.apiKey).toBe("hns_x");
    expect(config.logLevel).toBe("warn");
    expect(config.commandProfiles["echo-prompt"]?.argv).toEqual(["echo"]);
    expect(config.repositories[0]?.worktrees[0]?.labels).toEqual(["codex"]);
  });

  it("defaults branch and log level", () => {
    const config = parseAgentConfig({
      agentId: "x",
      logLevel: "nope",
      repositories: [
        {
          id: "r",
          path: "/r",
          worktrees: [{ id: "w", path: "/r/w", labels: [] }],
        },
      ],
    });
    expect(config.repositories[0]?.defaultBranch).toBe("main");
    expect(config.logLevel).toBe("info");
    expect(Object.keys(config.commandProfiles)).toEqual([]);
  });

  it("rejects empty repositories", () => {
    expect(() => parseAgentConfig({ agentId: "x", repositories: [], commandProfiles: {} })).toThrow(
      /repositories/,
    );
  });

  it("rejects non-object root and bad profiles", () => {
    expect(() => parseAgentConfig(null)).toThrow(/object/);
    expect(() =>
      parseAgentConfig({
        ...valid,
        commandProfiles: { bad: { argv: [] } },
      }),
    ).toThrow(/argv/);
    expect(() =>
      parseAgentConfig({
        ...valid,
        commandProfiles: { bad: "x" },
      }),
    ).toThrow(/object/);
    expect(() =>
      parseAgentConfig({
        ...valid,
        commandProfiles: "nope",
      }),
    ).toThrow(/commandProfiles/);
  });

  it("rejects invalid worktree and repo fields", () => {
    expect(() =>
      parseAgentConfig({
        agentId: "x",
        commandProfiles: {},
        repositories: [{ id: "r", path: "/r", worktrees: "x" }],
      }),
    ).toThrow(/worktrees/);
    expect(() =>
      parseAgentConfig({
        agentId: "x",
        commandProfiles: {},
        repositories: [
          {
            id: "r",
            path: "/r",
            worktrees: [{ id: "w", path: "/w", labels: "x" }],
          },
        ],
      }),
    ).toThrow(/labels/);
    expect(() =>
      parseAgentConfig({
        agentId: "x",
        commandProfiles: {},
        repositories: [null],
      }),
    ).toThrow(/object/);
    expect(() =>
      parseAgentConfig({
        agentId: "x",
        commandProfiles: {},
        repositories: [
          {
            id: "r",
            path: "/r",
            setupScript: 1,
            worktrees: [{ id: "w", path: "/w", labels: [] }],
          },
        ],
      }),
    ).toThrow(/setupScript/);
    expect(() =>
      parseAgentConfig({
        agentId: "x",
        commandProfiles: {},
        repositories: [
          {
            id: "r",
            path: "/r",
            terminalHookScript: 1,
            worktrees: [{ id: "w", path: "/w", labels: [] }],
          },
        ],
      }),
    ).toThrow(/terminalHookScript/);
    expect(() =>
      parseAgentConfig({
        agentId: "x",
        commandProfiles: {},
        repositories: [
          {
            id: "r",
            path: "/r",
            worktrees: [{ id: "w", path: "/w", labels: [], setupScript: 1 }],
          },
        ],
      }),
    ).toThrow(/setupScript/);
    expect(() =>
      parseAgentConfig({
        agentId: "x",
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
