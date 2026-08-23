import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  hostEnvironmentReady,
  repositoryEnvironmentReadiness,
} from "./control-plane-host-environment.ts";

describe("host environment readiness", () => {
  it("combines host and repository names and exposes only missing names", () => {
    const plane = new ControlPlane();
    plane.state.hostInventories.set("host-1", {
      hostId: "host-1",
      requiredEnvironment: ["GLOBAL_TOKEN"],
      repositories: [
        {
          id: "repo-1",
          path: "/repo",
          defaultBranch: "main",
          requiredEnvironment: ["REPO_TOKEN", "GLOBAL_TOKEN"],
          worktrees: [],
        },
      ],
      providerAccounts: [],
      updatedAt: "now",
      runtime: {
        daemonVersion: "test",
        gitVersion: "2.36.0",
        gitReady: true,
        environmentNames: ["GLOBAL_TOKEN"],
      },
    });
    expect(repositoryEnvironmentReadiness(plane.state, "host-1", "repo-1")).toEqual({
      required: ["GLOBAL_TOKEN", "REPO_TOKEN"],
      missing: ["REPO_TOKEN"],
      ready: false,
    });
    expect(hostEnvironmentReady(plane.state, "host-1", "unknown")).toBe(true);
    plane.state.hostInventories.get("host-1")!.runtime!.environmentNames!.push("REPO_TOKEN");
    expect(hostEnvironmentReady(plane.state, "host-1", "repo-1")).toBe(true);
  });
});
