import { describe, expect, it, vi } from "vitest";

import type { DeploymentConfig } from "./deployment-config.ts";
import { inspectLiveTables } from "./deployment-purge-schema.ts";
import type { DeploymentDependencies } from "./deployment-support.ts";
import { DYNAMO_TABLES } from "./tables.ts";

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

function dependencies(query: DeploymentDependencies["query"]): DeploymentDependencies {
  return { fetch: vi.fn(), log: vi.fn(), query, run: vi.fn() };
}

function activeTable(gsiNames: string[] = []) {
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

const notFound = {
  status: 255,
  stderr:
    "An error occurred (ResourceNotFoundException) when calling the DescribeTable operation: " +
    "Requested resource not found",
  stdout: "",
};

describe("inspectLiveTables", () => {
  it("omits a table that does not exist yet", async () => {
    const query = vi.fn(async () => notFound);
    const result = await inspectLiveTables(config, dependencies(query));
    expect(result).toEqual({});
    expect(query).toHaveBeenCalledTimes(DYNAMO_TABLES.length);
  });

  it("returns each existing table's live GSI names, behind the catalog or not", async () => {
    const liveSessionsGsis = [
      "statusShard-createdAt",
      "statusShard-queueOrder",
      "repositoryId-createdAt",
    ];
    const query = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes(`${config.tablePrefix}-Sessions`)) return activeTable(liveSessionsGsis);
      if (args.includes(`${config.tablePrefix}-Users`)) return activeTable(["username"]);
      return notFound;
    });
    const result = await inspectLiveTables(config, dependencies(query));
    expect(result).toEqual({ Sessions: liveSessionsGsis, Users: ["username"] });
  });

  it("refuses when a table itself is not ACTIVE", async () => {
    const query = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes(`${config.tablePrefix}-Sessions`)) {
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({
            Table: { GlobalSecondaryIndexes: [], TableStatus: "UPDATING" },
          }),
        };
      }
      return notFound;
    });
    await expect(inspectLiveTables(config, dependencies(query))).rejects.toThrow(
      "AutoHarness-review-Sessions is mid-transition, refusing to purge: table is UPDATING",
    );
  });

  it("refuses when a GSI is mid-transition even though the table itself is ACTIVE", async () => {
    const query = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes(`${config.tablePrefix}-Sessions`)) {
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
      return notFound;
    });
    await expect(inspectLiveTables(config, dependencies(query))).rejects.toThrow(
      "statusShard-priorityOrder is CREATING",
    );
  });

  it("throws on a describe-table failure other than the table not existing", async () => {
    const query = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes(`${config.tablePrefix}-Sessions`)) {
        return { status: 255, stderr: "An error occurred (AccessDeniedException)", stdout: "" };
      }
      return notFound;
    });
    await expect(inspectLiveTables(config, dependencies(query))).rejects.toThrow(
      "unable to inspect AutoHarness-review-Sessions: An error occurred (AccessDeniedException)",
    );
  });

  it("treats a blank successful response the same as an empty description", async () => {
    const query = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes(`${config.tablePrefix}-Sessions`)) {
        return { status: 0, stderr: "", stdout: "" };
      }
      return notFound;
    });
    // An empty Table means no TableStatus, which fails closed as "not ACTIVE" rather than
    // silently treating an unparseable response as a healthy table.
    await expect(inspectLiveTables(config, dependencies(query))).rejects.toThrow(
      "table is unknown",
    );
  });
});
