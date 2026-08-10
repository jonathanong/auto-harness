import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  parseHostRegistrationRepositories,
  resolveRegisteredRepositories,
} from "./control-plane-agent-registration.ts";

describe("host registration repository inventory", () => {
  it("keeps zero-worktree repositories in the host inventory and fleet list", () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "connection" });
    expect(
      plane.registerHost({
        hostId: "host",
        repositories: [{ id: "repo", path: "/repo", defaultBranch: "trunk" }],
        worktrees: [],
        commandProfiles: [],
      }),
    ).toEqual({ ok: true, connectionId: "connection" });
    expect(plane.getHostInventory("host")?.repositories).toEqual([
      { id: "repo", path: "/repo", defaultBranch: "trunk", worktrees: [] },
    ]);
    expect(plane.listHosts()[0]).toMatchObject({
      repositoryIds: ["repo"],
      repositories: [{ id: "repo", path: "/repo" }],
    });
  });

  it("derives older registrations from worktrees and rejects malformed input", () => {
    expect(
      resolveRegisteredRepositories(
        undefined,
        [{ id: "w", name: "w", repositoryId: "repo", path: "/repo/w", labels: [] }],
        undefined,
      ),
    ).toEqual([{ id: "repo", path: "/repo/w", defaultBranch: "main" }]);
    expect(() =>
      parseHostRegistrationRepositories([
        { id: "repo", path: "/r" },
        { id: "repo", path: "/r2" },
      ]),
    ).toThrow("duplicate repository repo");
  });
});
