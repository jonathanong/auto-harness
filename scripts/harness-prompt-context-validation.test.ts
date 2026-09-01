import { readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type Fixture, fixture, run, stubGh } from "./harness-prompt-context-test-helpers.ts";

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const fx of fixtures.splice(0)) {
    rmSync(fx.root, { force: true, recursive: true });
  }
});

function make(): Fixture {
  const fx = fixture();
  fixtures.push(fx);
  return fx;
}

describe("harness-prompt-context run script input validation", () => {
  it("rejects an unsupported search-mode before making any gh call", () => {
    const fx = make();
    stubGh(fx.bin, fx.callLog, 'echo "unexpected gh call: $*" >&2; exit 1');

    const result = run(fx, { SEARCH_MODE: "pr-commit" });
    const calls = readFileSync(fx.callLog, "utf8");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Unsupported search-mode: pr-commit");
    expect(calls).toBe("");
  });

  it("rejects a non-numeric topic-key in pr-commits mode before any gh call", () => {
    const fx = make();
    stubGh(fx.bin, fx.callLog, 'echo "unexpected gh call: $*" >&2; exit 1');

    const result = run(fx, { SEARCH_MODE: "pr-commits", TOPIC_KEY: "abc" });
    const calls = readFileSync(fx.callLog, "utf8");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("pr-commits mode requires a positive numeric topic-key");
    expect(calls).toBe("");
  });

  it("rejects a zero topic-key in pr-commits mode before any gh call", () => {
    const fx = make();
    stubGh(fx.bin, fx.callLog, 'echo "unexpected gh call: $*" >&2; exit 1');

    const result = run(fx, { SEARCH_MODE: "pr-commits", TOPIC_KEY: "0" });
    const calls = readFileSync(fx.callLog, "utf8");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("pr-commits mode requires a positive numeric topic-key");
    expect(calls).toBe("");
  });

  it("rejects a non-boolean check-prs value before any gh call", () => {
    const fx = make();
    stubGh(fx.bin, fx.callLog, 'echo "unexpected gh call: $*" >&2; exit 1');

    const result = run(fx, { CHECK_PRS: "yes" });
    const calls = readFileSync(fx.callLog, "utf8");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("check-prs must be 'true' or 'false'");
    expect(calls).toBe("");
  });

  it("rejects a non-boolean check-issues value before any gh call", () => {
    const fx = make();
    stubGh(fx.bin, fx.callLog, 'echo "unexpected gh call: $*" >&2; exit 1');

    const result = run(fx, { CHECK_ISSUES: "1" });
    const calls = readFileSync(fx.callLog, "utf8");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("check-issues must be 'true' or 'false'");
    expect(calls).toBe("");
  });

  it("rejects a non-positive-integer related-limit before any gh call", () => {
    const fx = make();
    stubGh(fx.bin, fx.callLog, 'echo "unexpected gh call: $*" >&2; exit 1');

    const result = run(fx, { RELATED_LIMIT: "0" });
    const calls = readFileSync(fx.callLog, "utf8");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("related-limit must be a positive integer");
    expect(calls).toBe("");
  });
});
