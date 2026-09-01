import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run, stubGh, useFixtures } from "./harness-prompt-context-test-helpers.ts";

const { make } = useFixtures();

const REJECTIONS: Array<{ name: string; env: Record<string, string>; message: string }> = [
  {
    name: "an unsupported search-mode",
    env: { SEARCH_MODE: "pr-commit" },
    message: "Unsupported search-mode: pr-commit",
  },
  {
    name: "a non-numeric topic-key in pr-commits mode",
    env: { SEARCH_MODE: "pr-commits", TOPIC_KEY: "abc" },
    message: "pr-commits mode requires a positive numeric topic-key",
  },
  {
    name: "a zero topic-key in pr-commits mode",
    env: { SEARCH_MODE: "pr-commits", TOPIC_KEY: "0" },
    message: "pr-commits mode requires a positive numeric topic-key",
  },
  {
    name: "a non-boolean check-prs value",
    env: { CHECK_PRS: "yes" },
    message: "check-prs must be 'true' or 'false'",
  },
  {
    name: "a non-boolean check-issues value",
    env: { CHECK_ISSUES: "1" },
    message: "check-issues must be 'true' or 'false'",
  },
  {
    name: "a non-positive-integer related-limit",
    env: { RELATED_LIMIT: "0" },
    message: "related-limit must be a positive integer",
  },
];

describe("harness-prompt-context run script input validation", () => {
  it.each(REJECTIONS)("rejects $name before making any gh call", ({ env, message }) => {
    const fx = make();
    stubGh(fx.bin, fx.callLog, 'echo "unexpected gh call: $*" >&2; exit 1');

    const result = run(fx, env);
    const calls = readFileSync(fx.callLog, "utf8");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(message);
    expect(calls).toBe("");
  });
});
