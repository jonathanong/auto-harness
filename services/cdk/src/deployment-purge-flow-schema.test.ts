import { describe, expect, it, vi } from "vitest";

import { config, dependencies } from "../test-helpers/deployment-test-helpers.ts";
import { runDeployment } from "./deployment.ts";

const allSessionGsis = [
  "statusShard-createdAt",
  "statusShard-createdOrder",
  "statusShard-queueOrder",
  "statusShard-priorityOrder",
  "statusShard-repositoryPriorityOrder",
  "repositoryId-createdAt",
  "parentSessionId-createdOrder",
  "activeHostId-activeHostOrder",
];

function withSessionsDescribeTable(
  deps: ReturnType<typeof dependencies>,
  gsiNames: string[],
): void {
  const query = deps.query;
  deps.query = vi.fn(async (command, args) => {
    if (args.includes("describe-table") && args.includes("AutoHarness-review-Sessions")) {
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify({
          Table: {
            GlobalSecondaryIndexes: gsiNames.map((IndexName) => ({
              IndexName,
              IndexStatus: "ACTIVE",
            })),
            TableStatus: "ACTIVE",
          },
        }),
      };
    }
    return query(command, args);
  });
}

function retargetGsiContext(deps: ReturnType<typeof dependencies>): Record<string, string[]> {
  const retargetRun = deps.runs.find((run) => run.includes("deploy"))!;
  const flag = retargetRun.find((arg) => arg.startsWith("existingGsiNamesByTable="))!;
  return JSON.parse(flag.slice("existingGsiNamesByTable=".length)) as Record<string, string[]>;
}

describe("runDeployment purge — schema drift", () => {
  it("purges an environment whose Sessions table is behind the catalog by more than one index", async () => {
    // Reproduces the production case (docs/deploy-aws.md): 3 of 8 Sessions GSIs live. The old
    // retarget synthesized the complete 8-index catalog and collided with DynamoDB's
    // one-GSI-change-per-update limit; this only restricts the retarget to what's live.
    const liveSessionsGsis = [
      "statusShard-createdAt",
      "statusShard-queueOrder",
      "repositoryId-createdAt",
    ];
    const deps = dependencies([true, true, true, false, false, false]);
    withSessionsDescribeTable(deps, liveSessionsGsis);

    await runDeployment(
      "purge",
      config({ purgeConfirmation: "destroy-all-data-in-review", teardownConfirmation: "review" }),
      deps,
    );

    expect(retargetGsiContext(deps).Sessions).toEqual(liveSessionsGsis);
    // Purge still completed exhaustively despite the drift.
    expect(deps.runs).toHaveLength(3);
  });

  it("purges a current-schema environment exactly as before", async () => {
    const deps = dependencies([true, true, true, false, false, false]);
    withSessionsDescribeTable(deps, allSessionGsis);

    await runDeployment(
      "purge",
      config({ purgeConfirmation: "destroy-all-data-in-review", teardownConfirmation: "review" }),
      deps,
    );

    // Live already matches the full catalog, so the restriction is a no-op: every catalog
    // index is still present, in the same order the catalog defines them.
    expect(retargetGsiContext(deps).Sessions).toEqual(allSessionGsis);
    expect(deps.runs).toHaveLength(3);
    expect(deps.runs[0]).toEqual(
      expect.arrayContaining(["destroy", "AutoHarness-review-Web", "AutoHarness-review-Runtime"]),
    );
    expect(deps.runs[2]).toEqual(
      expect.arrayContaining(["destroy", "AutoHarness-review-Foundation", "--force"]),
    );
  });

  it("refuses before destroying web or runtime when a table is mid-transition", async () => {
    const deps = dependencies([true, true, true, false, false, false]);
    const query = deps.query;
    deps.query = vi.fn(async (command, args) => {
      if (args.includes("describe-table") && args.includes("AutoHarness-review-Sessions")) {
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({
            Table: {
              GlobalSecondaryIndexes: [
                { IndexName: "statusShard-priorityOrder", IndexStatus: "CREATING" },
              ],
              TableStatus: "ACTIVE",
            },
          }),
        };
      }
      return query(command, args);
    });

    await expect(
      runDeployment(
        "purge",
        config({ purgeConfirmation: "destroy-all-data-in-review", teardownConfirmation: "review" }),
        deps,
      ),
    ).rejects.toThrow("statusShard-priorityOrder is CREATING");
    // Nothing was destroyed — the pre-flight check ran before web/runtime teardown.
    expect(deps.runs).toHaveLength(0);
  });
});
