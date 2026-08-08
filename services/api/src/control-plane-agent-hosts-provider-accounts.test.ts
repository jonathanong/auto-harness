import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("agent host inventory providerAccounts", () => {
  it("round-trips top-level providerAccounts and per-scope overrides", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    const put = plane.putAgentHostConfig("local-1", {
      repositories: [
        {
          id: "demo",
          path: "/repo",
          providerAccountOverrides: { "acct-1": { enabled: false } },
          worktrees: [
            {
              id: "wt-1",
              name: "wt-1",
              path: "/repo/wt-1",
              labels: [],
              providerAccountOverrides: { "acct-1": { enabled: true, commandId: "cmd-2" } },
            },
          ],
        },
      ],
      providerAccounts: [
        { providerAccountId: "acct-1", commandId: "cmd-1" },
        { providerAccountId: "acct-2" },
      ],
      commandProfiles: {},
    });
    expect(put.ok).toBe(true);
    const config = plane.getAgentHostConfig("local-1");
    expect(config?.providerAccounts).toEqual([
      { providerAccountId: "acct-1", commandId: "cmd-1" },
      { providerAccountId: "acct-2" },
    ]);
    expect(config?.repositories[0]?.providerAccountOverrides).toEqual({
      "acct-1": { enabled: false },
    });
    expect(config?.repositories[0]?.worktrees[0]?.providerAccountOverrides).toEqual({
      "acct-1": { enabled: true, commandId: "cmd-2" },
    });
  });

  it("defaults providerAccounts to an empty array when omitted", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    plane.putAgentHostConfig("local-1", { repositories: [], commandProfiles: {} });
    expect(plane.getAgentHostConfig("local-1")?.providerAccounts).toEqual([]);
  });

  it("rejects a non-array top-level providerAccounts", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    const put = plane.putAgentHostConfig("local-1", {
      repositories: [],
      providerAccounts: "nope",
      commandProfiles: {},
    });
    expect(put.ok).toBe(false);
  });

  it("rejects a malformed worktree providerAccountOverrides", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    const put = plane.putAgentHostConfig("local-1", {
      repositories: [
        {
          id: "demo",
          path: "/repo",
          worktrees: [
            {
              id: "wt-1",
              name: "wt-1",
              path: "/repo/wt-1",
              labels: [],
              providerAccountOverrides: "nope",
            },
          ],
        },
      ],
      commandProfiles: {},
    });
    expect(put.ok).toBe(false);
  });

  it("rejects a malformed repository providerAccountOverrides", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    const put = plane.putAgentHostConfig("local-1", {
      repositories: [
        {
          id: "demo",
          path: "/repo",
          providerAccountOverrides: "nope",
          worktrees: [],
        },
      ],
      commandProfiles: {},
    });
    expect(put.ok).toBe(false);
  });
});
