import { describe, expect, it, vi } from "vitest";

import { config, dependencies } from "../test-helpers/deployment-test-helpers.ts";
import { runDeployment } from "./deployment.ts";

type Deps = ReturnType<typeof dependencies>;

function putItemCalls(deps: Deps): string[][] {
  return deps.queries.filter((args) => args.includes("put-item"));
}

const FRESH_STACK_STATES = [false, false, false, true, true, true];

describe("fresh-deploy readiness markers", () => {
  it("writes both readiness markers only after a fresh deploy's smoke check passes", async () => {
    const deps = dependencies(FRESH_STACK_STATES);
    await runDeployment("deploy", config(), deps);
    const putItems = putItemCalls(deps);
    expect(putItems).toHaveLength(2);
    expect(putItems[0]).toEqual(
      expect.arrayContaining([
        "dynamodb",
        "put-item",
        "--table-name",
        "AutoHarness-review-SessionDrains",
        "--item",
        JSON.stringify({
          scopeKey: { S: "__session-drain-ledger__" },
          recordKey: { S: "ACTIVITY-V1" },
          recordType: { S: "activity-ledger-v1" },
        }),
        "--condition-expression",
        "attribute_not_exists(scopeKey)",
      ]),
    );
    expect(putItems[1]).toEqual(
      expect.arrayContaining([
        "--item",
        JSON.stringify({
          scopeKey: { S: "__session-priority-order__" },
          recordKey: { S: "READY-V2" },
          recordType: { S: "session-priority-order-v2" },
        }),
      ]),
    );
    expect(deps.log).toHaveBeenCalledWith(
      "Published session-drain-ledger and session-priority-order readiness markers for the new environment.",
    );
  });

  it("never writes readiness markers when updating an existing environment", async () => {
    const deps = dependencies([true, true, true, true, true, true]);
    await runDeployment("update", config(), deps);
    expect(putItemCalls(deps)).toHaveLength(0);
  });

  it("does not write markers when the post-deploy smoke check fails", async () => {
    const deps = dependencies(FRESH_STACK_STATES);
    deps.fetch = async () => new Response("no", { status: 503 });
    await expect(runDeployment("deploy", config(), deps)).rejects.toThrow("HTTP 503");
    expect(putItemCalls(deps)).toHaveLength(0);
  });

  it("treats a marker that already exists as success, not an error", async () => {
    const deps = dependencies(FRESH_STACK_STATES);
    const query = deps.query;
    deps.query = vi.fn(async (command, args) => {
      if (args.includes("put-item")) {
        deps.queries.push([command, ...args]);
        return { status: 255, stderr: "ConditionalCheckFailedException: ...", stdout: "" };
      }
      return query(command, args);
    });
    await expect(runDeployment("deploy", config(), deps)).resolves.toBeUndefined();
    expect(putItemCalls(deps)).toHaveLength(2);
  });

  it("re-running deploy is harmless once both markers are already published", async () => {
    const deps = dependencies(FRESH_STACK_STATES);
    await runDeployment("deploy", config(), deps);
    const second = dependencies(FRESH_STACK_STATES);
    const query = second.query;
    second.query = vi.fn(async (command, args) =>
      args.includes("put-item")
        ? { status: 255, stderr: "ConditionalCheckFailedException: ...", stdout: "" }
        : query(command, args),
    );
    await expect(runDeployment("deploy", config(), second)).resolves.toBeUndefined();
  });

  it("surfaces a genuine put-item failure instead of swallowing it", async () => {
    const deps = dependencies(FRESH_STACK_STATES);
    const query = deps.query;
    deps.query = vi.fn(async (command, args) =>
      args.includes("put-item")
        ? { status: 255, stderr: "AccessDeniedException: ...", stdout: "" }
        : query(command, args),
    );
    await expect(runDeployment("deploy", config(), deps)).rejects.toThrow(
      "could not publish readiness marker",
    );
  });
});
