import { describe, expect, it, vi } from "vitest";

import { config, dependencies } from "../test-helpers/deployment-test-helpers.ts";
import { runDeployment } from "./deployment.ts";

function withOrphanTemplate(deps: ReturnType<typeof dependencies>, orphanTableName: string): void {
  const query = deps.query;
  deps.query = vi.fn(async (command, args) => {
    if (args.includes("get-template")) {
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify({
          TemplateBody: {
            Resources: {
              OrphanTable: {
                Properties: { TableName: orphanTableName },
                Type: "AWS::DynamoDB::Table",
              },
              SessionsTable: {
                Properties: { TableName: "AutoHarness-review-Sessions" },
                Type: "AWS::DynamoDB::Table",
              },
            },
          },
        }),
      };
    }
    return query(command, args);
  });
}

/**
 * A single chronological record of the AWS-CLI-relevant steps this feature touches, spanning
 * both dependencies.query (get-template, update-table) and dependencies.run (the retarget
 * deploy, the foundation destroy, wait, delete-table) — the two are recorded into separate
 * arrays by the shared test helper, which can't otherwise prove one kind of call happened
 * before or after the other.
 */
function withOrderTracking(deps: ReturnType<typeof dependencies>): string[] {
  const order: string[] = [];
  const query = deps.query;
  deps.query = vi.fn(async (command, args) => {
    if (args.includes("get-template")) order.push("get-template");
    if (args.includes("update-table")) order.push("update-table");
    return query(command, args);
  });
  const run = deps.run;
  deps.run = vi.fn(async (command, args) => {
    if (args.includes("deploy") && args.includes("AutoHarness-review-Foundation")) {
      order.push("retarget-deploy");
    }
    if (args.includes("destroy") && args.includes("AutoHarness-review-Foundation")) {
      order.push("foundation-destroy");
    }
    if (args.includes("wait")) order.push("wait");
    if (args.includes("delete-table")) order.push("delete-table");
    return run(command, args);
  });
  return order;
}

describe("runDeployment purge — orphaned tables", () => {
  it("deletes a table the catalog no longer owns and still reports purge success", async () => {
    // Reproduces the production incident: SessionLogs was retired from tables.ts, but the
    // old foundation stack's own stored template still names it as an owned resource.
    const deps = dependencies([true, true, true, false, false, false]);
    withOrphanTemplate(deps, "AutoHarness-review-SessionLogs");

    await runDeployment(
      "purge",
      config({ purgeConfirmation: "destroy-all-data-in-review", teardownConfirmation: "review" }),
      deps,
    );

    expect(
      deps.queries.some(
        (query) =>
          query.includes("update-table") &&
          query.includes("AutoHarness-review-SessionLogs") &&
          query.includes("--no-deletion-protection-enabled"),
      ),
    ).toBe(true);
    expect(
      deps.runs.some(
        (run) => run.includes("delete-table") && run.includes("AutoHarness-review-SessionLogs"),
      ),
    ).toBe(true);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("Deleted orphaned DynamoDB table AutoHarness-review-SessionLogs"),
    );
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("Purge complete for environment review"),
    );
  });

  it("issues no update-table or delete-table calls when the stored template matches the catalog exactly", async () => {
    // Uses the shared test helper's default get-template response, which already matches
    // the full DYNAMO_TABLES catalog under the "AutoHarness-review" prefix.
    const deps = dependencies([true, true, true, false, false, false]);

    await runDeployment(
      "purge",
      config({ purgeConfirmation: "destroy-all-data-in-review", teardownConfirmation: "review" }),
      deps,
    );

    expect(deps.queries.some((query) => query.includes("update-table"))).toBe(false);
    expect(deps.runs.some((run) => run.includes("delete-table"))).toBe(false);
    // Unchanged from before this feature existed: exactly the web+runtime destroy, the
    // retarget deploy, and the foundation destroy.
    expect(deps.runs).toHaveLength(3);
  });

  it("detects orphans before the retarget deploy rewrites the stack's own stored template", async () => {
    // findOrphanedTableNames reads `--template-stage Original`, which always reflects the
    // *currently deployed* template. If it ran after retargetFoundationForDeletion's `cdk
    // deploy` — which is the fix that already dropped the orphaned resource from the stack
    // as an ordinary update — the orphan would already be invisible and this whole feature
    // would silently do nothing. This proves the strict ordering, not just that both steps
    // eventually happen.
    const deps = dependencies([true, true, true, false, false, false]);
    withOrphanTemplate(deps, "AutoHarness-review-SessionLogs");
    const order = withOrderTracking(deps);

    await runDeployment(
      "purge",
      config({ purgeConfirmation: "destroy-all-data-in-review", teardownConfirmation: "review" }),
      deps,
    );

    expect(order.indexOf("get-template")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("get-template")).toBeLessThan(order.indexOf("retarget-deploy"));
  });

  it("attempts orphan table deletion only after the foundation stack is destroyed", async () => {
    const deps = dependencies([true, true, true, false, false, false]);
    withOrphanTemplate(deps, "AutoHarness-review-SessionLogs");
    const order = withOrderTracking(deps);

    await runDeployment(
      "purge",
      config({ purgeConfirmation: "destroy-all-data-in-review", teardownConfirmation: "review" }),
      deps,
    );

    expect(order).toEqual([
      "get-template",
      "retarget-deploy",
      "foundation-destroy",
      "update-table",
      "wait",
      "delete-table",
    ]);
  });

  it("carries the captured orphan list through in memory rather than re-deriving it after the stack is gone", async () => {
    // Once the foundation stack is destroyed, `get-template` no longer works for it at all —
    // the stack doesn't exist any more. If deleteOrphanedTables (or anything between the
    // retarget and the cleanup step) re-derived the orphan set by calling get-template
    // again instead of using the list findOrphanedTableNames already captured in memory, it
    // would see zero orphans post-destroy, silently delete nothing, and still report
    // success — precisely the bug this feature exists to prevent. This fake answers
    // get-template correctly only on its first call; any second call fails the way the real
    // AWS CLI would against an already-destroyed stack.
    const deps = dependencies([true, true, true, false, false, false]);
    let getTemplateCalls = 0;
    const query = deps.query;
    deps.query = vi.fn(async (command, args) => {
      if (args.includes("get-template")) {
        getTemplateCalls += 1;
        if (getTemplateCalls > 1) {
          return {
            status: 255,
            stderr:
              "An error occurred (ValidationError) when calling the GetTemplate operation: " +
              "Stack [AutoHarness-review-Foundation] does not exist",
            stdout: "",
          };
        }
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({
            TemplateBody: {
              Resources: {
                OrphanTable: {
                  Properties: { TableName: "AutoHarness-review-SessionLogs" },
                  Type: "AWS::DynamoDB::Table",
                },
                SessionsTable: {
                  Properties: { TableName: "AutoHarness-review-Sessions" },
                  Type: "AWS::DynamoDB::Table",
                },
              },
            },
          }),
        };
      }
      return query(command, args);
    });

    await runDeployment(
      "purge",
      config({ purgeConfirmation: "destroy-all-data-in-review", teardownConfirmation: "review" }),
      deps,
    );

    expect(getTemplateCalls).toBe(1);
    expect(
      deps.runs.some(
        (run) => run.includes("delete-table") && run.includes("AutoHarness-review-SessionLogs"),
      ),
    ).toBe(true);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("Purge complete for environment review"),
    );
  });

  it("throws naming the surviving orphan and never reports purge success when deletion fails", async () => {
    const deps = dependencies([true, true, true, false, false, false]);
    withOrphanTemplate(deps, "AutoHarness-review-SessionLogs");
    const run = deps.run;
    deps.run = vi.fn(async (command, args) => {
      if (args.includes("delete-table")) throw new Error("ResourceInUseException");
      return run(command, args);
    });

    await expect(
      runDeployment(
        "purge",
        config({ purgeConfirmation: "destroy-all-data-in-review", teardownConfirmation: "review" }),
        deps,
      ),
    ).rejects.toThrow("AutoHarness-review-SessionLogs");

    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining("Purge complete"));
  });
});
