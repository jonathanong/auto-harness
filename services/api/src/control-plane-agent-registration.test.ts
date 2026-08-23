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

  it("preserves the configured host setup script across daemon registration", () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "connection" });
    expect(
      plane.putHostInventory("host", {
        setupScript: "source ~/.zshrc",
        requiredEnvironment: ["GLOBAL_TOKEN"],
        repositories: [
          {
            id: "repo",
            path: "/repo",
            defaultBranch: "main",
            requiredEnvironment: ["REPO_TOKEN"],
            worktrees: [],
          },
        ],
      }).ok,
    ).toBe(true);
    expect(
      plane.registerHost({
        hostId: "host",
        repositories: [{ id: "repo", path: "/repo", defaultBranch: "main" }],
        worktrees: [],
      }),
    ).toEqual({ ok: true, connectionId: "connection" });
    expect(plane.getHostInventory("host")?.setupScript).toBe("source ~/.zshrc");
    expect(plane.getHostInventory("host")?.requiredEnvironment).toEqual(["GLOBAL_TOKEN"]);
    expect(plane.getHostInventory("host")?.repositories[0]?.requiredEnvironment).toEqual([
      "REPO_TOKEN",
    ]);
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

  it("marks a legacy registration without a runtime report as not ready", () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "connection" });
    expect(
      plane.handleHostMessage({
        type: "host:register",
        hostId: "legacy-host",
        worktrees: [],
      }),
    ).toEqual({ ok: true });
    expect(plane.listHosts()).toEqual([
      expect.objectContaining({
        hostId: "legacy-host",
        daemonVersion: "legacy/unknown",
        gitVersion: null,
        gitReady: false,
        gitReadinessReason: "git_readiness_unreported",
      }),
    ]);
  });

  it("rejects an unbounded runtime environment report before persisting it", () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "connection" });
    expect(
      plane.registerHost({
        hostId: "invalid-runtime-host",
        worktrees: [],
        runtime: {
          daemonVersion: "test",
          gitVersion: "2.36.0",
          gitReady: true,
          environmentNames: Array.from({ length: 257 }, (_, index) => `TOKEN_${index}`),
        },
      }),
    ).toEqual({ ok: false, error: "runtime report is invalid" });
    expect(plane.getHostInventory("invalid-runtime-host")).toBeNull();
  });

  it("rejects an invalid environment-name comparison mode before persisting it", () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "connection" });
    expect(
      plane.registerHost({
        hostId: "invalid-runtime-host",
        worktrees: [],
        runtime: {
          daemonVersion: "test",
          gitVersion: "2.36.0",
          gitReady: true,
          environmentNamesCaseSensitive: "no",
        } as never,
      }),
    ).toEqual({ ok: false, error: "runtime report is invalid" });
    expect(plane.getHostInventory("invalid-runtime-host")).toBeNull();
  });

  it("exposes drain state in the host fleet view", () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "draining-connection" });
    expect(plane.registerHost({ hostId: "draining-host", worktrees: [], draining: true })).toEqual({
      ok: true,
      connectionId: "draining-connection",
    });
    expect(plane.listHosts().find((host) => host.hostId === "draining-host")).toMatchObject({
      online: true,
      draining: true,
    });
  });
});
