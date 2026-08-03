import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("agent host inventory", () => {
  it("stores config, syncs worktrees, and lists profiles", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    const put = plane.putAgentHostConfig("local-1", {
      agentId: "local-1",
      logLevel: "debug",
      repositories: [
        {
          id: "demo",
          path: "/repo",
          defaultBranch: "main",
          setupScript: "true",
          terminalHookScript: "/hook",
          worktrees: [
            { id: "wt-1", path: "/repo/wt-1", labels: ["echo"], setupScript: "true" },
            { id: "wt-2", path: "/repo/wt-2", labels: [] },
          ],
        },
      ],
      commandProfiles: {
        "echo-prompt": { argv: ["echo"], appendPrompt: true },
        true: { argv: ["true"], appendPrompt: false },
      },
    });
    expect(put.ok).toBe(true);
    expect(plane.getAgentHostConfig("local-1")?.repositories[0]?.path).toBe("/repo");
    expect(plane.listWorktrees().filter((w) => w.agentId === "local-1")).toHaveLength(2);
    expect(plane.listCommandProfiles()).toEqual(expect.arrayContaining(["echo-prompt", "true"]));
    expect(plane.listAgentHostConfigs()).toHaveLength(1);

    // Replace inventory: drop wt-2, keep wt-1
    const replace = plane.putAgentHostConfig("local-1", {
      repositories: [
        {
          id: "demo",
          path: "/repo",
          worktrees: [{ id: "wt-1", path: "/repo/wt-1", labels: ["echo"] }],
        },
      ],
      commandProfiles: { "echo-prompt": { argv: ["echo"] } },
    });
    expect(replace.ok).toBe(true);
    expect(plane.listWorktrees().map((w) => w.id)).toEqual(["wt-1"]);

    expect(plane.putAgentHostConfig("local-1", { repositories: [] }).ok).toBe(false);
    expect(plane.putAgentHostConfig("local-1", null).ok).toBe(false);
    expect(
      plane.putAgentHostConfig("local-1", {
        agentId: "other",
        repositories: [{ id: "d", path: "/r", worktrees: [{ id: "w", path: "/w", labels: [] }] }],
        commandProfiles: {},
      }).ok,
    ).toBe(false);
    expect(
      plane.putAgentHostConfig("x", {
        repositories: [{ id: "d", path: "/r", worktrees: "x" }],
        commandProfiles: {},
      }).ok,
    ).toBe(false);
    expect(
      plane.putAgentHostConfig("x", {
        repositories: [{ id: "d", path: "/r", worktrees: [{ id: "w", path: "/w", labels: "x" }] }],
        commandProfiles: {},
      }).ok,
    ).toBe(false);
    expect(
      plane.putAgentHostConfig("x", {
        repositories: [{ id: "d", path: "/r", worktrees: [null] }],
        commandProfiles: {},
      }).ok,
    ).toBe(false);
    expect(
      plane.putAgentHostConfig("x", {
        repositories: [null],
        commandProfiles: {},
      }).ok,
    ).toBe(false);
    expect(
      plane.putAgentHostConfig("x", {
        repositories: [
          { id: "d", path: "/r", setupScript: 1, worktrees: [{ id: "w", path: "/w", labels: [] }] },
        ],
        commandProfiles: {},
      }).ok,
    ).toBe(false);
    expect(
      plane.putAgentHostConfig("x", {
        repositories: [
          {
            id: "d",
            path: "/r",
            terminalHookScript: 1,
            worktrees: [{ id: "w", path: "/w", labels: [] }],
          },
        ],
        commandProfiles: {},
      }).ok,
    ).toBe(false);
    expect(
      plane.putAgentHostConfig("x", {
        repositories: [
          {
            id: "d",
            path: "/r",
            worktrees: [{ id: "w", path: "/w", labels: [], setupScript: 1 }],
          },
        ],
        commandProfiles: {},
      }).ok,
    ).toBe(false);
    expect(
      plane.putAgentHostConfig("x", {
        repositories: [{ id: "d", path: "/r", worktrees: [{ id: "w", path: "/w", labels: [] }] }],
        commandProfiles: "x",
      }).ok,
    ).toBe(false);
    expect(
      plane.putAgentHostConfig("x", {
        repositories: [{ id: "d", path: "/r", worktrees: [{ id: "w", path: "/w", labels: [] }] }],
        commandProfiles: { bad: "x" },
      }).ok,
    ).toBe(false);
    expect(
      plane.putAgentHostConfig("x", {
        repositories: [{ id: "d", path: "/r", worktrees: [{ id: "w", path: "/w", labels: [] }] }],
        commandProfiles: { bad: { argv: [] } },
      }).ok,
    ).toBe(false);

    expect(plane.deleteAgentHostConfig("local-1").ok).toBe(true);
    expect(plane.getAgentHostConfig("local-1")).toBeNull();
    expect(plane.deleteAgentHostConfig("local-1").ok).toBe(false);
  });
});
