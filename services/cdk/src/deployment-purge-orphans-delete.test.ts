import { describe, expect, it, vi } from "vitest";

import type { DeploymentConfig } from "./deployment-config.ts";
import { deleteOrphanedTables } from "./deployment-purge-orphans.ts";
import type { DeploymentDependencies } from "./deployment-support.ts";

const config: DeploymentConfig = {
  accessLogsEnabled: false,
  adminsSsmParam: "/auto-harness/review/harness-admins",
  alarmEmails: [],
  cursorSecretSsmParam: "/auto-harness/review/harness-cursor-secret",
  environment: "review",
  foundationStackName: "AutoHarness-review-Foundation",
  publicBaseUrlSsmParam: "/auto-harness/review/public-base-url",
  purgeSsmParameters: false,
  region: "us-west-2",
  removalPolicy: "destroy",
  runtimeStackName: "AutoHarness-review-Runtime",
  sessionSecretSsmParam: "/auto-harness/review/harness-session-secret",
  slackAppSsmParam: "/auto-harness/review/slack-app",
  tablePrefix: "AutoHarness-review",
  webStackName: "AutoHarness-review-Web",
};

const updateTableSucceeds: DeploymentDependencies["query"] = vi.fn(async () => ({
  status: 0,
  stderr: "",
  stdout: "",
}));

function dependencies(
  query: DeploymentDependencies["query"] = updateTableSucceeds,
  run: DeploymentDependencies["run"] = vi.fn(async () => undefined),
): DeploymentDependencies & { queries: string[][]; runs: string[][] } {
  const queries: string[][] = [];
  const runs: string[][] = [];
  return {
    fetch: vi.fn(),
    log: vi.fn(),
    queries,
    query: vi.fn(async (command, args) => {
      queries.push([command, ...args]);
      return query(command, args);
    }),
    run: vi.fn(async (command, args) => {
      runs.push([command, ...args]);
      await run(command, args);
    }),
    runs,
  };
}

describe("deleteOrphanedTables", () => {
  it("does nothing when there are no orphans — no update-table, wait, or delete-table calls", async () => {
    const deps = dependencies();
    await deleteOrphanedTables(config, deps, []);
    expect(deps.queries).toHaveLength(0);
    expect(deps.runs).toHaveLength(0);
  });

  it("disables deletion protection, waits for ACTIVE, then deletes each orphan, reporting it", async () => {
    const deps = dependencies();
    await deleteOrphanedTables(config, deps, ["AutoHarness-review-SessionLogs"]);
    expect(deps.queries).toHaveLength(1);
    expect(deps.queries[0]).toEqual(
      expect.arrayContaining([
        "dynamodb",
        "update-table",
        "--table-name",
        "AutoHarness-review-SessionLogs",
        "--no-deletion-protection-enabled",
      ]),
    );
    expect(deps.runs).toHaveLength(2);
    expect(deps.runs[0]).toEqual(
      expect.arrayContaining([
        "dynamodb",
        "wait",
        "table-exists",
        "--table-name",
        "AutoHarness-review-SessionLogs",
      ]),
    );
    expect(deps.runs[1]).toEqual(
      expect.arrayContaining([
        "dynamodb",
        "delete-table",
        "--table-name",
        "AutoHarness-review-SessionLogs",
      ]),
    );
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("Deleted orphaned DynamoDB table AutoHarness-review-SessionLogs"),
    );
  });

  it("treats a table already removed by the retarget's own stack update as done, not failed", async () => {
    // A stored template's DeletionPolicy can be Delete rather than Retain — when it is,
    // retargetFoundationForDeletion's own `cdk deploy` already deleted this table before
    // deleteOrphanedTables ever runs. update-table then fails with ResourceNotFoundException,
    // which must be treated as already-cleaned-up, not as a surviving orphan.
    const query: DeploymentDependencies["query"] = vi.fn(async () => ({
      status: 255,
      stderr:
        "An error occurred (ResourceNotFoundException) when calling the UpdateTable operation: " +
        "Requested resource not found",
      stdout: "",
    }));
    const deps = dependencies(query);
    await deleteOrphanedTables(config, deps, ["AutoHarness-review-SessionLogs"]);
    // No wait or delete-table call: there is nothing left to wait for or delete.
    expect(deps.runs).toHaveLength(0);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("AutoHarness-review-SessionLogs no longer exists"),
    );
  });

  it("throws when update-table fails for a reason other than the table already being gone", async () => {
    const query: DeploymentDependencies["query"] = vi.fn(async () => ({
      status: 255,
      stderr: "An error occurred (AccessDeniedException)",
      stdout: "",
    }));
    const deps = dependencies(query);
    await expect(
      deleteOrphanedTables(config, deps, ["AutoHarness-review-SessionLogs"]),
    ).rejects.toThrow("AutoHarness-review-SessionLogs");
    // No wait or delete-table call: update-table itself never succeeded.
    expect(deps.runs).toHaveLength(0);
  });

  it("falls back to stdout in the error message when update-table fails with no stderr", async () => {
    const query: DeploymentDependencies["query"] = vi.fn(async () => ({
      status: 255,
      stderr: "",
      stdout: "AccessDeniedException on stdout",
    }));
    const deps = dependencies(query);
    await expect(
      deleteOrphanedTables(config, deps, ["AutoHarness-review-SessionLogs"]),
    ).rejects.toThrow("AutoHarness-review-SessionLogs");
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("AccessDeniedException on stdout"),
    );
  });

  it("throws naming the surviving table when delete-table fails, without reporting success", async () => {
    const run: DeploymentDependencies["run"] = vi.fn(async (_command, args) => {
      if (args.includes("delete-table")) throw new Error("ResourceInUseException");
    });
    const deps = dependencies(updateTableSucceeds, run);
    await expect(
      deleteOrphanedTables(config, deps, ["AutoHarness-review-SessionLogs"]),
    ).rejects.toThrow("AutoHarness-review-SessionLogs");
    // wait and delete-table both ran; only delete-table failed.
    expect(deps.runs).toHaveLength(2);
  });

  it("stringifies a non-Error throw when reporting a failed deletion", async () => {
    const run: DeploymentDependencies["run"] = vi.fn(async (_command, args) => {
      // dependencies.run in production always rejects with an Error, but this loop's catch
      // does not assume that — a non-Error throw is still reported without crashing.
      if (args.includes("delete-table")) throw "ResourceInUseException";
    });
    const deps = dependencies(updateTableSucceeds, run);
    await expect(
      deleteOrphanedTables(config, deps, ["AutoHarness-review-SessionLogs"]),
    ).rejects.toThrow("AutoHarness-review-SessionLogs");
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Failed to delete orphaned table AutoHarness-review-SessionLogs: ResourceInUseException",
      ),
    );
  });

  it("attempts every orphan even after one fails, and names only the survivor(s) in the end", async () => {
    const run: DeploymentDependencies["run"] = vi.fn(async (_command, args) => {
      if (args.includes("delete-table") && args.includes("AutoHarness-review-Bad")) {
        throw new Error("AccessDeniedException");
      }
    });
    const deps = dependencies(updateTableSucceeds, run);
    await expect(
      deleteOrphanedTables(config, deps, [
        "AutoHarness-review-Bad",
        "AutoHarness-review-SessionLogs",
      ]),
    ).rejects.toThrow(/^purge left 1 orphaned DynamoDB table\(s\) behind: AutoHarness-review-Bad$/);
    // The second table's full delete sequence still ran and succeeded despite the first's
    // failure — best-effort cleanup, not an early bail-out.
    expect(
      deps.runs.some(
        (call) => call.includes("delete-table") && call.includes("AutoHarness-review-SessionLogs"),
      ),
    ).toBe(true);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("Deleted orphaned DynamoDB table AutoHarness-review-SessionLogs"),
    );
  });
});
