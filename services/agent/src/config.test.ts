import { describe, expect, it } from "vitest";

import { findRepository, findWorktree, loadAgentConfig, parseAgentConfig } from "./config.js";

const valid = {
  agentId: "local-1",
  commandProfiles: {
    "echo-prompt": { argv: ["echo"], appendPrompt: true },
  },
  repositories: [
    {
      id: "repo-1",
      path: "/tmp/repo",
      defaultBranch: "main",
      setupScript: "true",
      terminalHookScript: "/tmp/hook.sh",
      worktrees: [
        {
          id: "wt-1",
          path: "/tmp/repo/wt-1",
          labels: ["codex"],
          setupScript: "true",
        },
      ],
    },
  ],
};

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

describe("loadAgentConfig", () => {
  it("applies env overrides", () => {
    const config = loadAgentConfig({
      inline: valid,
      env: {
        HARNESS_AGENT_ID: "from-env",
        HARNESS_API_URL: "ws://localhost/ws",
        HARNESS_API_KEY: "hns_x",
        HARNESS_LOG_LEVEL: "debug",
      },
    });
    expect(config.agentId).toBe("from-env");
    expect(config.apiUrl).toBe("ws://localhost/ws");
    expect(config.apiKey).toBe("hns_x");
    expect(config.logLevel).toBe("debug");
    // default env from process when options.env omitted (inline still used)
    const withProcessEnv = loadAgentConfig({ inline: valid });
    expect(withProcessEnv.agentId).toBe("local-1");
  });

  it("loads from a config file path and HARNESS_CONFIG_PATH", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { chdir } = await import("node:process");
    const dir = mkdtempSync(join(tmpdir(), "ah-cfg-"));
    const path = join(dir, "cfg.json");
    writeFileSync(path, JSON.stringify(valid));
    const config = loadAgentConfig({ configPath: path, env: {} });
    expect(config.agentId).toBe("local-1");
    const viaEnv = loadAgentConfig({
      env: { HARNESS_CONFIG_PATH: path, HARNESS_LOG_LEVEL: "error" },
    });
    expect(viaEnv.logLevel).toBe("error");
    const cwd = process.cwd();
    try {
      chdir(dir);
      writeFileSync(join(dir, "auto-harness-agent.config.json"), JSON.stringify(valid));
      const def = loadAgentConfig({ env: {} });
      expect(def.agentId).toBe("local-1");
    } finally {
      chdir(cwd);
    }
    void mkdirSync;
  });

  it("rejects missing agentId", () => {
    expect(() =>
      parseAgentConfig({ repositories: valid.repositories, commandProfiles: {} }),
    ).toThrow(/agentId/);
  });
});

describe("find helpers", () => {
  it("finds repo and worktree", () => {
    const config = parseAgentConfig(valid);
    expect(findRepository(config, "repo-1")?.id).toBe("repo-1");
    expect(findWorktree(config, "repo-1", "wt-1")?.id).toBe("wt-1");
    expect(findWorktree(config, "repo-1", "nope")).toBeUndefined();
  });
});
