import { describe, expect, it } from "vitest";

import { parseHostBody } from "./control-plane-agent-hosts-parse.ts";
import { drainHostDurable } from "./control-plane-agents.ts";
import { ControlPlane } from "./control-plane.ts";

describe("agent inventory guard coverage", () => {
  it("rejects missing repository strings, non-array repositories, and invalid worktree names", () => {
    expect(() => parseHostBody("host", { repositories: "invalid", commandProfiles: {} })).toThrow(
      "repositories must be an array",
    );
    expect(() =>
      parseHostBody("host", {
        repositories: [{ id: "", path: "/repo", worktrees: [] }],
        commandProfiles: {},
      }),
    ).toThrow("id must be a non-empty string");
    expect(() =>
      parseHostBody("host", {
        repositories: [
          {
            id: "repository",
            path: "/repo",
            worktrees: [{ id: "worktree", name: "NOT VALID", path: "/repo/w", labels: [] }],
          },
        ],
        commandProfiles: {},
      }),
    ).toThrow("name must be");
  });

  it("filters durable drain results by both host and running state", async () => {
    const plane = new ControlPlane();
    const base = {
      repositoryId: "repository",
      prompt: "work",
      target: { commandId: "command" },
      fallbacks: [],
      targetDisplayNames: ["command"],
      queueTtlSeconds: 60,
      queueExpiresAt: "later",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      queueShard: 0,
      createdAt: "now",
      worktreeId: null,
      type: "prompt" as const,
      source: "api" as const,
    };
    plane.state.sessions.set("running", {
      ...base,
      id: "running",
      hostId: "host",
      status: "running",
    });
    plane.state.sessions.set("queued", {
      ...base,
      id: "queued",
      hostId: "host",
      status: "queued",
    });
    plane.state.sessions.set("other", {
      ...base,
      id: "other",
      hostId: "other",
      status: "running",
    });
    plane.state.storage = {
      getHostLock: async () => "owner",
      markHostDraining: async () => true,
    } as never;

    await expect(drainHostDurable(plane.state, "host")).resolves.toEqual({
      ok: true,
      runningSessionIds: ["running"],
    });
  });
});
