/**
 * Host pane: host config is API-owned; UI is Next.js (local:agent-web).
 * Unit-level coverage hits control-plane host config + agent identity env.
 */
import { describe, expect, it } from "vitest";

import { ControlPlane } from "../services/api/src/control-plane.ts";

describe("host pane host inventory API", () => {
  it("stores host config for an agent id", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    const put = plane.putAgentHostConfig("local-1", {
      repositories: [
        {
          id: "demo",
          path: "/repo",
          defaultBranch: "main",
          worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: ["echo"] }],
        },
      ],
      commandProfiles: { "echo-prompt": { argv: ["echo"], appendPrompt: true } },
    });
    expect(put.ok).toBe(true);
    expect(plane.getAgentHostConfig("local-1")?.repositories[0]?.path).toBe("/repo");
    plane.drainAgent("local-1");
    expect(plane.isDraining("local-1")).toBe(true);
  });
});
