import { describe, expect, it } from "vitest";

import { fetchGitHubPullRequestRef } from "./git-github-pull-ref.ts";
import { scripted } from "../test-helpers/git-test-helpers.ts";

const cwd = "/tmp/auto-harness-github-pull-ref-test";
const remoteUrl = "https://github.com/example/repository.git";
const ref = "refs/pull/42/head";

const initialized = { match: ["init", "--bare", "*"], exitCode: 0 };
const fetched = {
  match: [
    "--git-dir",
    "*",
    "fetch",
    "--no-write-fetch-head",
    "--no-tags",
    remoteUrl,
    `+${ref}:refs/auto-harness/pull-fetch/source`,
  ],
  exitCode: 0,
};
const resolved = {
  match: [
    "--git-dir",
    "*",
    "rev-parse",
    "--verify",
    "refs/auto-harness/pull-fetch/source^{commit}",
  ],
  exitCode: 0,
  stdout: "pull-sha\n",
};
const bundled = {
  match: ["--git-dir", "*", "bundle", "create", "*", "refs/auto-harness/pull-fetch/source"],
  exitCode: 0,
};
const imported = { match: ["bundle", "unbundle", "*"], exitCode: 0 };

describe("isolated GitHub pull-ref fetch", () => {
  it("ignores ordinary refs and pull refs without a pinned origin", async () => {
    const runner = scripted([]);
    await expect(fetchGitHubPullRequestRef(runner, cwd, "main", remoteUrl)).resolves.toBeNull();
    await expect(fetchGitHubPullRequestRef(runner, cwd, ref, undefined)).resolves.toBeNull();
  });

  it.each([
    ["initialization", [{ ...initialized, exitCode: 1 }]],
    ["resolution", [initialized, fetched, { ...resolved, exitCode: 1, stdout: "" }]],
    ["empty resolution", [initialized, fetched, { ...resolved, stdout: "\n" }]],
    ["bundle creation", [initialized, fetched, resolved, { ...bundled, exitCode: 1 }]],
    ["bundle import", [initialized, fetched, resolved, bundled, { ...imported, exitCode: 1 }]],
    [
      "scratch-ref update",
      [
        initialized,
        fetched,
        resolved,
        bundled,
        imported,
        { match: ["update-ref", "--no-deref", "*", "pull-sha"], exitCode: 1 },
      ],
    ],
  ])("returns null after failed %s", async (_stage, steps) => {
    await expect(
      fetchGitHubPullRequestRef(scripted(steps), cwd, ref, remoteUrl),
    ).resolves.toBeNull();
  });

  it("roots an already-present pull head without creating an empty bundle", async () => {
    const destination = await fetchGitHubPullRequestRef(
      scripted([
        initialized,
        fetched,
        resolved,
        {
          match: ["--git-dir", "*", "merge-base", "--is-ancestor", "pull-sha", "base-sha"],
          exitCode: 0,
        },
        { match: ["update-ref", "--no-deref", "*", "pull-sha"], exitCode: 0 },
      ]),
      cwd,
      ref,
      { remoteUrl, transport: {} },
      "/srv/repository/.git/objects",
      "base-sha",
    );

    expect(destination).toMatchObject({
      ref: expect.stringMatching(/^refs\/worktree\/auto-harness\/pull-fetch\//),
      sha: "pull-sha",
    });
  });
});
