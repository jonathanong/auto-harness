import { describe, expect, it, vi } from "vitest";

import {
  findRepository,
  findWorktree,
  loadAgentConfig,
  loadAgentIdentity,
  parseAgentConfig,
} from "./config.ts";
import { valid } from "./config-test-helpers.ts";

describe("loadAgentIdentity", () => {
  it("defaults to local agent id and API URL when env is empty", () => {
    expect(loadAgentIdentity({})).toEqual({
      hostId: "local-1",
      apiUrl: "http://127.0.0.1:7420",
      logLevel: "info",
    });
  });

  it("accepts HARNESS_API_HTTP as API base alias", () => {
    expect(
      loadAgentIdentity({
        HARNESS_AGENT_ID: "a1",
        HARNESS_API_HTTP: "http://127.0.0.1:7420",
        HARNESS_API_KEY: "hns_x",
        HARNESS_LOG_LEVEL: "debug",
      }),
    ).toEqual({
      hostId: "a1",
      apiUrl: "http://127.0.0.1:7420",
      apiKey: "hns_x",
      logLevel: "debug",
    });
  });
});

describe("loadAgentConfig", () => {
  it("applies env overrides on inline config", async () => {
    const config = await loadAgentConfig({
      inline: valid,
      env: {
        HARNESS_AGENT_ID: "from-env",
        HARNESS_API_URL: "ws://localhost/ws",
        HARNESS_API_KEY: "hns_x",
        HARNESS_LOG_LEVEL: "debug",
      },
    });
    expect(config.hostId).toBe("from-env");
    expect(config.apiUrl).toBe("ws://localhost/ws");
    expect(config.apiKey).toBe("hns_x");
    expect(config.logLevel).toBe("debug");

    for (const level of ["info", "warn", "error"] as const) {
      const c = await loadAgentConfig({
        inline: valid,
        env: { HARNESS_LOG_LEVEL: level },
      });
      expect(c.logLevel).toBe(level);
    }
  });

  it("bootstraps host inventory from the control plane", async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          hostId: "local-1",
          repositories: valid.repositories,
          commandProfiles: valid.commandProfiles,
          logLevel: "info",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const config = await loadAgentConfig({
      env: {
        HARNESS_AGENT_ID: "local-1",
        HARNESS_API_URL: "http://127.0.0.1:7420",
        HARNESS_API_KEY: "hns_test",
      },
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(config.hostId).toBe("local-1");
    expect(config.repositories[0]?.id).toBe("repo-1");
    expect(config.commandProfiles["echo-prompt"]?.argv).toEqual(["echo"]);
    expect(config.apiKey).toBe("hns_test");
    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:7420/api/v1/hosts/local-1/inventory",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer hns_test" }),
      }),
    );
  });

  it("rejects missing hostId in parsed config", () => {
    expect(() =>
      parseAgentConfig({ repositories: valid.repositories, commandProfiles: {} }),
    ).toThrow(/hostId/);
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
