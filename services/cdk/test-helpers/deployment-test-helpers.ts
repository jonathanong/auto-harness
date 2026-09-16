import { vi } from "vitest";

import type { DeploymentConfig } from "../src/deployment-config.ts";
import type { DeploymentDependencies } from "../src/deployment-support.ts";

export const config = (overrides: Partial<DeploymentConfig> = {}): DeploymentConfig => ({
  accessLogsEnabled: false,
  adminsSsmParam: "/auto-harness/review/harness-admins",
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
    fetch: vi.fn(async () => new Response('{"ok":true}', { status: 200 })),
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
