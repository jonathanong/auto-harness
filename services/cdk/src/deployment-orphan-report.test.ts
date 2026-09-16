import { describe, expect, it, vi } from "vitest";

import type { DeploymentConfig } from "./deployment-config.ts";
import { reportOrphanedTablesAfterUpdate } from "./deployment-orphan-report.ts";
import type { DeploymentDependencies } from "./deployment-support.ts";

const config: DeploymentConfig = {
  accessLogsEnabled: false,
  adminsSsmParam: "/auto-harness/review/harness-admins",
  cursorSecretSsmParam: "/auto-harness/review/harness-cursor-secret",
  environment: "review",
  foundationStackName: "AutoHarness-review-Foundation",
  publicBaseUrlSsmParam: "/auto-harness/review/public-base-url",
  purgeSsmParameters: false,
  region: "us-west-2",
  removalPolicy: "retain",
  runtimeStackName: "AutoHarness-review-Runtime",
  sessionSecretSsmParam: "/auto-harness/review/harness-session-secret",
  slackAppSsmParam: "/auto-harness/review/slack-app",
  tablePrefix: "AutoHarness-review",
  webStackName: "AutoHarness-review-Web",
};

function dependencies(query: DeploymentDependencies["query"]): DeploymentDependencies & {
  log: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
} {
  return { fetch: vi.fn(), log: vi.fn(), query, run: vi.fn() };
}

const found = {
  status: 0,
  stderr: "",
  stdout: JSON.stringify({ Table: { TableStatus: "ACTIVE" } }),
};
const missing = {
  status: 255,
  stderr: "An error occurred (ResourceNotFoundException) when calling DescribeTable",
  stdout: "",
};

describe("reportOrphanedTablesAfterUpdate", () => {
  it("reports a table the update abandoned instead of deleted", async () => {
    // The production shape: DeletionPolicy Retain, so the resource left the stack but the
    // table is still live.
    const deps = dependencies(vi.fn(async () => found));
    const survivors = await reportOrphanedTablesAfterUpdate(config, deps, [
      "AutoHarness-review-SessionLogs",
    ]);

    expect(survivors).toEqual(["AutoHarness-review-SessionLogs"]);
    const logged = deps.log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("AutoHarness-review-SessionLogs");
    expect(logged).toContain("WARNING");
    // The operator needs to know a later purge will not clean this up for them.
    expect(logged).toContain("purge");
    // And an exact command, since deletion protection blocks a plain delete-table.
    expect(logged).toContain("--no-deletion-protection-enabled");
    expect(logged).toContain("delete-table --table-name AutoHarness-review-SessionLogs");
  });

  it("stays silent when the dropped table really was deleted", async () => {
    // DeletionPolicy: Delete — the stack update removed it properly, nothing to report.
    const deps = dependencies(vi.fn(async () => missing));
    const survivors = await reportOrphanedTablesAfterUpdate(config, deps, [
      "AutoHarness-review-SessionLogs",
    ]);

    expect(survivors).toEqual([]);
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("does nothing at all when the update dropped no tables", async () => {
    const query = vi.fn(async () => found);
    const deps = dependencies(query);

    expect(await reportOrphanedTablesAfterUpdate(config, deps, [])).toEqual([]);
    // Not one describe-table call on the overwhelmingly common no-op path.
    expect(query).not.toHaveBeenCalled();
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("reports only the survivors when a batch is mixed", async () => {
    const query = vi.fn(async (_cmd: string, args: readonly string[]) =>
      args.includes("AutoHarness-review-Gone") ? missing : found,
    );
    const deps = dependencies(query as unknown as DeploymentDependencies["query"]);

    expect(
      await reportOrphanedTablesAfterUpdate(config, deps, [
        "AutoHarness-review-Gone",
        "AutoHarness-review-Stayed",
      ]),
    ).toEqual(["AutoHarness-review-Stayed"]);
    const logged = deps.log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("AutoHarness-review-Stayed");
    expect(logged).not.toContain("AutoHarness-review-Gone");
  });

  it("never deletes anything — an update must not destroy data as a side effect", async () => {
    // The whole reason this path reports rather than deletes. `run` is what issues
    // update-table / delete-table in the purge path; it must stay untouched here.
    const deps = dependencies(vi.fn(async () => found));
    await reportOrphanedTablesAfterUpdate(config, deps, ["AutoHarness-review-SessionLogs"]);
    expect(deps.run).not.toHaveBeenCalled();
  });
});
