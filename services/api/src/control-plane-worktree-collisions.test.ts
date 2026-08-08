import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("worktree name uniqueness across hosts", () => {
  it("putAgentHostConfig rejects duplicate names within one request and across hosts", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    const dup = plane.putAgentHostConfig("host-a", {
      repositories: [
        {
          id: "r1",
          path: "/r",
          worktrees: [
            { id: "w1", name: "same-name", path: "/r/w1", labels: [] },
            { id: "w2", name: "same-name", path: "/r/w2", labels: [] },
          ],
        },
      ],
      commandProfiles: {},
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.error).toContain("already used in this same request");
    }

    const first = plane.putAgentHostConfig("host-a", {
      repositories: [
        {
          id: "r1",
          path: "/r",
          worktrees: [{ id: "w1", name: "shared", path: "/r/w1", labels: [] }],
        },
      ],
      commandProfiles: {},
    });
    expect(first.ok).toBe(true);

    const collide = plane.putAgentHostConfig("host-b", {
      repositories: [
        {
          id: "r2",
          path: "/r2",
          worktrees: [{ id: "w2", name: "shared", path: "/r2/w2", labels: [] }],
        },
      ],
      commandProfiles: {},
    });
    expect(collide.ok).toBe(false);
    if (!collide.ok) {
      expect(collide.error).toContain("already in use on host host-a");
    }
  });

  it("registerAgent rejects invalid slug names and cross-host name collisions", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    const invalid = plane.registerAgent({
      hostId: "host-c",
      worktrees: [{ id: "w1", name: "Not_A_Slug", repositoryId: "r1", path: "/r/w1", labels: [] }],
      commandProfiles: [],
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error).toContain("must be");
    }

    const first = plane.putAgentHostConfig("host-d", {
      repositories: [
        {
          id: "r1",
          path: "/r",
          worktrees: [{ id: "w1", name: "taken", path: "/r/w1", labels: [] }],
        },
      ],
      commandProfiles: {},
    });
    expect(first.ok).toBe(true);

    const collide = plane.registerAgent({
      hostId: "host-e",
      worktrees: [{ id: "w2", name: "taken", repositoryId: "r2", path: "/r2/w2", labels: [] }],
      commandProfiles: [],
    });
    expect(collide.ok).toBe(false);
    if (!collide.ok) {
      expect(collide.error).toContain("already in use on host host-d");
    }
  });
});
