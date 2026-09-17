import { vi } from "vitest";

import type { DeploymentConfig } from "../src/deployment-config.ts";
import type { DeploymentDependencies } from "../src/deployment-support.ts";
import { DYNAMO_TABLES } from "../src/tables.ts";

/**
 * A foundation stack template exactly matching the current catalog under the default
 * config()'s "AutoHarness-review" tablePrefix — the shared default so purge tests that
 * don't care about orphan detection see zero orphans and no new AWS calls. Tests that do
 * care override the "get-template" branch directly, the same way GSI-drift tests override
 * "describe-table" below.
 */
const CURRENT_CATALOG_TEMPLATE_STDOUT = JSON.stringify({
  TemplateBody: {
    Resources: Object.fromEntries(
      DYNAMO_TABLES.map((table, index) => [
        `Table${String(index)}`,
        {
          Properties: { TableName: `AutoHarness-review-${table.name}` },
          Type: "AWS::DynamoDB::Table",
        },
      ]),
    ),
  },
});

/**
 * What a working deployment serves at /login: the page shell, the server-rendered form,
 * and no Next control-flow digest. Trimmed from the real production response.
 *
 * These markers are duplicated from services/web on purpose — they are the contract
 * smokeDeployment asserts against a live distribution, which cannot import from the web
 * package. Renaming one there fails that package's own auth-forms-coverage test first;
 * this string must then be updated in step, or the next deploy fails at the smoke probe.
 */
export const HEALTHY_LOGIN_HTML = [
  "<!DOCTYPE html><html><body>",
  '<main data-pw="page-login">',
  '<div data-pw="login-card"><form data-pw="form-login">',
  '<button data-pw="login-submit">Sign in</button>',
  "</form></div></main></body></html>",
].join("");

export const config = (overrides: Partial<DeploymentConfig> = {}): DeploymentConfig => ({
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
  ...overrides,
});

/**
 * stackStates is consumed in order by each successive stackState() call this test drives
 * (foundation, runtime, web — the order stackState() itself queries in), not by CLI-call
 * order overall: a stackOutput() lookup (describe-stacks --query ...) never consumes an
 * entry, only a bare stackExists() describe-stacks call does.
 */
export function dependencies(stackStates: boolean[]): DeploymentDependencies & {
  queries: string[][];
  runs: string[][];
} {
  const queries: string[][] = [];
  const runs: string[][] = [];
  let stackIndex = 0;
  return {
    fetch: vi.fn(async (input: Parameters<typeof fetch>[0]) =>
      new URL(input as URL).pathname === "/health"
        ? new Response('{"ok":true}', { status: 200 })
        : new Response(HEALTHY_LOGIN_HTML, { status: 200 }),
    ),
    log: vi.fn(),
    queries,
    query: vi.fn(async (command, args) => {
      queries.push([command, ...args]);
      if (args.includes("describe-stacks")) {
        if (args.includes("--query")) {
          return { status: 0, stderr: "", stdout: "https://api.example.test\n" };
        }
        const exists = stackStates[stackIndex++] ?? false;
        return exists
          ? { status: 0, stderr: "", stdout: "stack" }
          : { status: 255, stderr: "ValidationError: stack does not exist", stdout: "" };
      }
      if (args.includes("list-stack-resources")) {
        return { status: 0, stderr: "", stdout: "" };
      }
      if (args.includes("get-caller-identity")) {
        return { status: 0, stderr: "", stdout: "123456789012\n" };
      }
      if (args.includes("get-template")) {
        return { status: 0, stderr: "", stdout: CURRENT_CATALOG_TEMPLATE_STDOUT };
      }
      if (args.includes("describe-table")) {
        // Default: a stable, current-schema table with no GSIs at all — the purge
        // pre-flight (inspectLiveTables) finds nothing to restrict and nothing mid-transition.
        // Tests exercising actual GSI drift override this branch directly.
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({ Table: { TableStatus: "ACTIVE", GlobalSecondaryIndexes: [] } }),
        };
      }
      if (
        args.includes("list-object-versions") ||
        args.includes("delete-objects") ||
        args.includes("delete-parameters")
      ) {
        return { status: 0, stderr: "", stdout: "{}" };
      }
      return { status: 0, stderr: "", stdout: "ok\n" };
    }),
    run: vi.fn(async (command, args) => {
      runs.push([command, ...args]);
    }),
    runs,
  };
}
