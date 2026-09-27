import { expect, it } from "vitest";
import { blackboardPolicy, parseBlackboardConfig } from "./blackboard-config.ts";
import { config } from "../test-helpers/blackboard-reporting-fixtures.ts";

it.each([
  "{",
  "null",
  "[]",
  ...[
    { unexpected: true },
    { schemaVersion: 2 },
    { version: 0 },
    { version: 1.5 },
    { url: 7 },
    { token: 7 },
    { token: "" },
    { token: "x".repeat(8193) },
    { policies: {} },
    { policies: [] },
    { policies: Array.from({ length: 101 }, () => config().policies[0]) },
  ].map((override) => JSON.stringify({ ...config(), ...override })),
])("rejects malformed deployment configuration without exposing its contents %#", (raw) => {
  expect(() => parseBlackboardConfig(raw)).toThrow("invalid Blackboard reporting configuration");
});

it.each([
  "invalid",
  "http://example.test",
  "https://user@example.test",
  "https://:password@example.test",
  "https://example.test?token=private",
  "https://example.test#private",
])("rejects credential-bearing or invalid deployment URL %s", (url) => {
  expect(() => parseBlackboardConfig(JSON.stringify(config(url)))).toThrow(
    "invalid Blackboard reporting URL",
  );
});

it.each([
  null,
  [],
  {},
  { ...config().policies[0], extra: true },
  { ...config().policies[0], workspacePoolId: "pool" },
  { ...config().policies[0], repositoryId: null },
  { ...config().policies[0], repositoryId: "invalid/path" },
  { ...config().policies[0], repositoryId: undefined, workspacePoolId: null },
  { ...config().policies[0], repositoryId: undefined, workspacePoolId: "invalid/path" },
  { ...config().policies[0], repository: 7 },
  { ...config().policies[0], repository: "Owner/Repo" },
  { ...config().policies[0], principalIds: {} },
  { ...config().policies[0], principalIds: [] },
  { ...config().policies[0], principalIds: Array.from({ length: 101 }, () => "system") },
  { ...config().policies[0], principalIds: [7] },
  { ...config().policies[0], principalIds: ["invalid/path"] },
])("rejects ambiguous or unbounded repository/principal policy %#", (policy) => {
  expect(() => parseBlackboardConfig(JSON.stringify({ ...config(), policies: [policy] }))).toThrow(
    "invalid Blackboard reporting policy",
  );
});

it("keeps repository and workspace authorization scoped, deduplicated and bounded", () => {
  const workspace = {
    workspacePoolId: "pool",
    repository: "owner/workspaces",
    principalIds: ["system"],
  };
  const parsed = parseBlackboardConfig(
    JSON.stringify({ ...config(), policies: [...config().policies, workspace] }),
  );
  expect(blackboardPolicy(parsed, "", undefined, "pool")).toEqual(workspace);
  expect(blackboardPolicy(parsed, "repo", "unconfigured")).toBeUndefined();
  expect(blackboardPolicy(undefined, "repo", "system")).toBeUndefined();
  expect(() =>
    parseBlackboardConfig(JSON.stringify({ ...config(), policies: [workspace, workspace] })),
  ).toThrow("duplicate");
  const oversized = {
    ...config(),
    policies: Array.from({ length: 100 }, (_, index) => ({
      repositoryId: `repo${index}-${"r".repeat(480)}`,
      repository: "owner/repo",
      principalIds: Array.from(
        { length: 100 },
        (_principalValue, principal) => `principal-${principal}`,
      ),
    })),
  };
  expect(() => parseBlackboardConfig(JSON.stringify(oversized))).toThrow("configuration too large");
});
