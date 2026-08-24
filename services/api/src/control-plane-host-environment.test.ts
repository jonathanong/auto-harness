import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  hostAcceptsNewAssignments,
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

  it("uses Windows lookup semantics only when a modern runtime reports them", () => {
    const plane = new ControlPlane();
    const inventory = {
      hostId: "host-1",
      requiredEnvironment: ["REPO_TOKEN"],
      repositories: [{ id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] }],
      providerAccounts: [],
      updatedAt: "now",
    };
    plane.state.hostInventories.set("host-1", {
      ...inventory,
      runtime: {
        daemonVersion: "test",
        gitVersion: "2.36.0",
        gitReady: true,
        environmentNames: ["Repo_Token"],
        environmentNamesCaseSensitive: false,
      },
    });
    expect(hostEnvironmentReady(plane.state, "host-1", "repo-1")).toBe(true);
    expect(plane.listHosts()).toMatchObject([
      {
        hostId: "host-1",
        environmentReadiness: {
          "repo-1": { required: ["REPO_TOKEN"], missing: [], ready: true },
        },
      },
    ]);

    plane.state.hostInventories.set("host-1", {
      ...inventory,
      runtime: {
        daemonVersion: "test",
        gitVersion: "2.36.0",
        gitReady: true,
        environmentNames: ["Repo_Token"],
        environmentNamesCaseSensitive: true,
      },
    });
    expect(hostEnvironmentReady(plane.state, "host-1", "repo-1")).toBe(false);

    plane.state.hostInventories.set("host-1", {
      ...inventory,
      runtime: {
        daemonVersion: "legacy",
        gitVersion: "2.36.0",
        gitReady: true,
        environmentNames: ["Repo_Token"],
      },
    });
    expect(repositoryEnvironmentReadiness(plane.state, "host-1", "repo-1")).toEqual({
      required: ["REPO_TOKEN"],
      missing: ["REPO_TOKEN"],
      ready: false,
    });
  });

  it("withholds new assignments from daemons below the fenced protocol", () => {
    const plane = new ControlPlane();
    expect(hostAcceptsNewAssignments(plane.state, "host-1")).toBe(false);
    plane.state.hostConnection.set("host-1", "c1");
    plane.state.connections.set("c1", {
      connectionId: "c1",
      type: "host",
      hostId: "host-1",
      connectedAt: "now",
      lastHeartbeatAt: "now",
    });
    expect(hostAcceptsNewAssignments(plane.state, "host-1")).toBe(false);
    plane.state.connections.set("c1", {
      ...plane.state.connections.get("c1")!,
      protocolVersion: 1,
    });
    expect(hostAcceptsNewAssignments(plane.state, "host-1")).toBe(true);
  });
});
