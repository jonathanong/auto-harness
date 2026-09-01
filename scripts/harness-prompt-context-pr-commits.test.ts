import { describe, expect, it } from "vitest";
import {
  stubPrCommits,
  stubPrCommitsJq,
} from "./harness-prompt-context-pr-commits-test-helpers.ts";
import { readGithubOutput, run, useFixtures } from "./harness-prompt-context-test-helpers.ts";

const { make } = useFixtures();

describe("harness-prompt-context run script pr-commits mode", () => {
  it("sets skip=true when the known PR already has a prior non-bot commit", () => {
    const fx = make();
    stubPrCommits(fx, `printf 'abc123\\ndef456\\n'`);

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
    stubPrCommits(fx, `printf ''`);

    const result = run(fx, { SEARCH_MODE: "pr-commits", TOPIC_KEY: "42" });
    const output = readGithubOutput(fx.githubOutput);

    expect(result.status, result.stderr).toBe(0);
    expect(output.skip).toBe("false");
    expect(output.existing_number).toBe("");
    expect(output.related_candidates).toBe("[]");
  });

  it("treats any bot-type commit author as bot, not just the two hardcoded logins", () => {
    const fx = make();
    // A bot outside the old dependabot[bot]/github-actions[bot] allowlist (e.g. pre-commit-ci[bot])
    // must still be excluded from the non-bot commit count via the GitHub API's own author.type,
    // not a hardcoded login list.
    const commits = JSON.stringify([
      { sha: "aaa1111", author: { login: "pre-commit-ci[bot]", type: "Bot" } },
    ]);
    stubPrCommitsJq(fx, commits);

    const result = run(fx, { SEARCH_MODE: "pr-commits", TOPIC_KEY: "42" });
    const output = readGithubOutput(fx.githubOutput);

    expect(result.status, result.stderr).toBe(0);
    expect(output.skip).toBe("false");
    expect(output.existing_number).toBe("");
  });

  it("does not treat a commit with an unassociated (null) author as proof of a non-bot commit", () => {
    const fx = make();
    // GitHub's pulls/commits API returns author: null when the commit's email isn't linked to
    // an account — including for bot commits like renovate[bot] with an unassociated address.
    // An unknown author is insufficient proof of a human commit; it must not clear skip=true.
    const commits = JSON.stringify([{ sha: "bbb2222", author: null }]);
    stubPrCommitsJq(fx, commits);

    const result = run(fx, { SEARCH_MODE: "pr-commits", TOPIC_KEY: "42" });
    const output = readGithubOutput(fx.githubOutput);

    expect(result.status, result.stderr).toBe(0);
    expect(output.skip).toBe("false");
    expect(output.existing_number).toBe("");
  });

  it("treats a mid-pagination gh api failure as no prior automated fix, discarding any partial results", () => {
    const fx = make();
    // Bash's command substitution captures stdout even when the command's own exit status is
    // nonzero, so a failure after gh api --paginate has already emitted a SHA from an earlier
    // page must not leave that partial output usable — it must fail open just like a
    // first-page failure does.
    stubPrCommits(
      fx,
      `echo "aaa1111"
    exit 1`,
    );

    const result = run(fx, { SEARCH_MODE: "pr-commits", TOPIC_KEY: "42" });
    const output = readGithubOutput(fx.githubOutput);

    expect(result.status, result.stderr).toBe(0);
    expect(output.skip).toBe("false");
    expect(output.existing_number).toBe("");
  });
});
