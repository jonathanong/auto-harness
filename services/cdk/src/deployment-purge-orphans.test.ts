import { describe, expect, it, vi } from "vitest";

import type { DeploymentConfig } from "./deployment-config.ts";
import { findOrphanedTableNames } from "./deployment-purge-orphans.ts";
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

function dependencies(query: DeploymentDependencies["query"]): DeploymentDependencies {
  return { fetch: vi.fn(), log: vi.fn(), query, run: vi.fn() };
}

function templateResponse(
  resources: Record<string, { Properties?: Record<string, unknown>; Type?: string }>,
) {
  return {
    status: 0,
    stderr: "",
    stdout: JSON.stringify({ TemplateBody: { Resources: resources } }),
  };
}

const CURRENT_CATALOG_SESSIONS = {
  SessionsTable: {
    Properties: { TableName: "AutoHarness-review-Sessions" },
    Type: "AWS::DynamoDB::Table",
  },
};

describe("findOrphanedTableNames", () => {
  it("detects a table present in the stored template but absent from the catalog", async () => {
    // Reproduces the production incident: SessionLogs was retired from tables.ts, but the
    // old stack's own stored template still names it.
    const query = vi.fn(async () =>
      templateResponse({
        ...CURRENT_CATALOG_SESSIONS,
        SessionLogsTable: {
          Properties: { TableName: "AutoHarness-review-SessionLogs" },
          Type: "AWS::DynamoDB::Table",
        },
      }),
    );
    const result = await findOrphanedTableNames(config, dependencies(query));
    expect(result).toEqual(["AutoHarness-review-SessionLogs"]);
  });

  it("calls get-template with the Original stage against this environment's foundation stack", async () => {
    const query = vi.fn(async () => templateResponse(CURRENT_CATALOG_SESSIONS));
    await findOrphanedTableNames(config, dependencies(query));
    expect(query).toHaveBeenCalledWith(
      "aws",
      expect.arrayContaining([
        "cloudformation",
        "get-template",
        "--stack-name",
        "AutoHarness-review-Foundation",
        "--template-stage",
        "Original",
      ]),
    );
  });

  it("returns no orphans when the stored template matches the catalog exactly", async () => {
    const query = vi.fn(async () => templateResponse(CURRENT_CATALOG_SESSIONS));
    const result = await findOrphanedTableNames(config, dependencies(query));
    expect(result).toEqual([]);
  });

  it("ignores non-table resources in the template", async () => {
    const query = vi.fn(async () =>
      templateResponse({
        ...CURRENT_CATALOG_SESSIONS,
        ArchiveBucket: { Properties: { BucketName: "review-archive" }, Type: "AWS::S3::Bucket" },
      }),
    );
    const result = await findOrphanedTableNames(config, dependencies(query));
    expect(result).toEqual([]);
  });

  it("skips a TableName that is an intrinsic rather than a plain string, without crashing", async () => {
    const query = vi.fn(async () =>
      templateResponse({
        ...CURRENT_CATALOG_SESSIONS,
        WeirdTable: {
          Properties: { TableName: { "Fn::Sub": "${AWS::StackName}-Weird" } },
          Type: "AWS::DynamoDB::Table",
        },
      }),
    );
    const deps = dependencies(query);
    const result = await findOrphanedTableNames(config, deps);
    // Not crashing and not silently treating it as an orphan (or as owned) — it's simply
    // excluded, and the operator is told why via a log line naming the logical id.
    expect(result).toEqual([]);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("WeirdTable"));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("not a plain string"));
  });

  it("handles a TemplateBody returned as a JSON string instead of a parsed object", async () => {
    const query = vi.fn(async () => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        TemplateBody: JSON.stringify({
          Resources: {
            SessionLogsTable: {
              Properties: { TableName: "AutoHarness-review-SessionLogs" },
              Type: "AWS::DynamoDB::Table",
            },
          },
        }),
      }),
    }));
    const result = await findOrphanedTableNames(config, dependencies(query));
    expect(result).toEqual(["AutoHarness-review-SessionLogs"]);
  });

  it("treats a blank successful response the same as an empty template", async () => {
    // The real AWS CLI can return blank stdout for some empty/degenerate responses; queryOk()
    // trims it to "", which must fall back to "no candidates" rather than crashing on
    // JSON.parse("").
    const query = vi.fn(async () => ({ status: 0, stderr: "", stdout: "" }));
    const result = await findOrphanedTableNames(config, dependencies(query));
    expect(result).toEqual([]);
  });

  it("treats a response with no TemplateBody field as an empty template", async () => {
    const query = vi.fn(async () => ({ status: 0, stderr: "", stdout: "{}" }));
    const result = await findOrphanedTableNames(config, dependencies(query));
    expect(result).toEqual([]);
  });

  it("treats a null TemplateBody as an empty template rather than crashing", async () => {
    const query = vi.fn(async () => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({ TemplateBody: null }),
    }));
    const result = await findOrphanedTableNames(config, dependencies(query));
    expect(result).toEqual([]);
  });

  it("treats a template with no Resources key as having no candidates", async () => {
    const query = vi.fn(async () => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({ TemplateBody: {} }),
    }));
    const result = await findOrphanedTableNames(config, dependencies(query));
    expect(result).toEqual([]);
  });

  it("does not treat another environment's prefix-colliding table as an orphan of this one", async () => {
    // "AutoHarness-prod-extra-Sessions" is a real, live table belonging to a completely
    // different environment ("prod-extra") that merely happens to share the
    // "AutoHarness-prod-" string prefix with environment "prod". A naive `list-tables` +
    // `startsWith(tablePrefix + "-")` design would conflate the two — exactly this table is
    // what such a scan would hand back and could then delete (see PR body). This mock wires
    // up a `list-tables` response with that exact name so a naive implementation run against
    // this same fixture would misidentify and delete it; findOrphanedTableNames must not
    // even ask for that list, because it only ever inspects the "prod" foundation stack's
    // own stored template — a single, precisely-scoped get-template call.
    const prodConfig: DeploymentConfig = {
      ...config,
      environment: "prod",
      foundationStackName: "AutoHarness-prod-Foundation",
      tablePrefix: "AutoHarness-prod",
    };
    const query = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("get-template")) {
        return templateResponse({
          SessionsTable: {
            Properties: { TableName: "AutoHarness-prod-Sessions" },
            Type: "AWS::DynamoDB::Table",
          },
        });
      }
      if (args.includes("list-tables")) {
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({
            TableNames: ["AutoHarness-prod-Sessions", "AutoHarness-prod-extra-Sessions"],
          }),
        };
      }
      throw new Error(`unexpected AWS CLI call: ${args.join(" ")}`);
    });
    const result = await findOrphanedTableNames(prodConfig, dependencies(query));
    expect(result).toEqual([]);
    expect(result).not.toContain("AutoHarness-prod-extra-Sessions");
    // Exactly one call, and it's the stack-scoped get-template — list-tables (which is wired
    // up above to return the colliding table) is never called at all.
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([, args]) => (args as string[]).includes("list-tables"))).toBe(
      false,
    );
  });
});
