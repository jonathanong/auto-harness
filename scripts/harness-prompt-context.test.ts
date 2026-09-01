import { readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Fixture,
  fixture,
  readGithubOutput,
  run,
  stubGh,
} from "./harness-prompt-context-test-helpers.ts";

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

describe("harness-prompt-context run script", () => {
  it("sets skip=true when the known PR already has a prior non-bot commit", () => {
    const fx = make();
    stubGh(
      fx.bin,
      fx.callLog,
      `case "$1 $2" in
  "pr view") echo "https://github.com/example/repo/pull/42" ;;
  "api --paginate") printf 'abc123\\ndef456\\n' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac`,
    );

    const result = run(fx, { SEARCH_MODE: "pr-commits", TOPIC_KEY: "42" });
    const output = readGithubOutput(fx.githubOutput);

    expect(result.status, result.stderr).toBe(0);
    expect(output.skip).toBe("true");
    expect(output.existing_number).toBe("42");
    expect(output.existing_kind).toBe("pr");
    expect(output.related_candidates).toBe("[]");
  });

  it("sets skip=false when the known PR has no non-bot commits", () => {
    const fx = make();
    stubGh(
      fx.bin,
      fx.callLog,
      `case "$1 $2" in
  "pr view") echo "https://github.com/example/repo/pull/42" ;;
  "api --paginate") printf '' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac`,
    );

    const result = run(fx, { SEARCH_MODE: "pr-commits", TOPIC_KEY: "42" });
    const output = readGithubOutput(fx.githubOutput);

    expect(result.status, result.stderr).toBe(0);
    expect(output.skip).toBe("false");
    expect(output.existing_number).toBe("");
    expect(output.related_candidates).toBe("[]");
  });

  it("emits combined related-candidates JSON via the resolved output writer", () => {
    const fx = make();
    const prs = '[{"kind":"pr","authorized":true,"number":7,"title":"Flaky test"}]';
    const issues = '[{"kind":"issue","authorized":true,"number":9,"title":"Flaky test also"}]';
    stubGh(
      fx.bin,
      fx.callLog,
      `case "$1 $2" in
  "pr list") printf '%s' '${prs}' ;;
  "issue list") printf '%s' '${issues}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac`,
    );

    const result = run(fx, { RELATED_TITLE_KEY: "flaky test" });
    const output = readGithubOutput(fx.githubOutput);
    const summary = readFileSync(fx.githubStepSummary, "utf8");

    expect(result.status, result.stderr).toBe(0);
    expect(output.skip).toBe("false");
    expect(JSON.parse(output.related_candidates ?? "")).toEqual([
      { kind: "pr", authorized: true, number: 7, title: "Flaky test" },
      { kind: "issue", authorized: true, number: 9, title: "Flaky test also" },
    ]);
    expect(summary).toContain("related candidates");
  });

  it("skips the related search entirely when related-title-key is empty", () => {
    const fx = make();
    stubGh(fx.bin, fx.callLog, 'echo "unexpected gh call: $*" >&2; exit 1');

    const result = run(fx, {});
    const output = readGithubOutput(fx.githubOutput);
    const calls = readFileSync(fx.callLog, "utf8");

    expect(result.status, result.stderr).toBe(0);
    expect(output.skip).toBe("false");
    expect(output.related_candidates).toBe("[]");
    expect(calls).toBe("");
  });

  it("fails fast, before any gh call, when vouchington-tooling is not installed", () => {
    const fx = make();
    rmSync(`${fx.githubWorkspace}/node_modules`, { force: true, recursive: true });
    stubGh(fx.bin, fx.callLog, 'echo "unexpected gh call: $*" >&2; exit 1');

    const result = run(fx, {});
    const calls = readFileSync(fx.callLog, "utf8");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not resolve vouchington-tooling");
    expect(calls).toBe("");
  });

  it("quotes newline-separated related-extra-labels so spaces survive in the search query", () => {
    const fx = make();
    stubGh(
      fx.bin,
      fx.callLog,
      `case "$1 $2" in
  "pr list") printf '%s' '[]' ;;
  "issue list") printf '%s' '[]' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac`,
    );

    const result = run(fx, {
      RELATED_TITLE_KEY: "flaky test",
      RELATED_EXTRA_LABELS: "automation\nneeds review",
    });
    const calls = readFileSync(fx.callLog, "utf8");

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain('label:"automation"');
    expect(calls).toContain('label:"needs review"');
  });

  it("treats any bot-type commit author as bot, not just the two hardcoded logins", () => {
    const fx = make();
    // A bot outside the old dependabot[bot]/github-actions[bot] allowlist (e.g. pre-commit-ci[bot])
    // must still be excluded from the non-bot commit count via the GitHub API's own author.type,
    // not a hardcoded login list.
    const commits = JSON.stringify([
      { sha: "aaa1111", author: { login: "pre-commit-ci[bot]", type: "Bot" } },
    ]);
    stubGh(
      fx.bin,
      fx.callLog,
      `case "$1 $2" in
  "pr view") echo "https://github.com/example/repo/pull/42" ;;
  "api --paginate")
    filter=""
    prev=""
    for arg in "$@"; do
      if [[ "$prev" == "--jq" ]]; then filter="$arg"; fi
      prev="$arg"
    done
    printf '%s' '${commits}' | jq -r "$filter"
    ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac`,
    );

    const result = run(fx, { SEARCH_MODE: "pr-commits", TOPIC_KEY: "42" });
    const output = readGithubOutput(fx.githubOutput);

    expect(result.status, result.stderr).toBe(0);
    expect(output.skip).toBe("false");
    expect(output.existing_number).toBe("");
  });
});
