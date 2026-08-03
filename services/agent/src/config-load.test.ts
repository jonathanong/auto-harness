import { describe, expect, it } from "vitest";

import { findRepository, findWorktree, loadAgentConfig, parseAgentConfig } from "./config.ts";
import { valid } from "./config-test-helpers.ts";

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
