/* eslint-disable max-lines -- failure modes and race regressions share one scripted transfer fixture. */
import { tmpdir } from "node:os";
import { parse } from "node:path";
import { describe, expect, it } from "vitest";

import { fetchGitHubPullRequestRef, nullGlobalGitConfigPath } from "./git-github-pull-ref.ts";
import { scripted } from "../test-helpers/git-test-helpers.ts";

const cwd = "/tmp/auto-harness-github-pull-ref-test";
const remoteUrl = "https://github.com/example/repository.git";
const ref = "refs/pull/42/head";
const pullSha = "0123456789abcdef0123456789abcdef01234567";

const initialized = { match: ["init", "--bare", "--object-format=sha1", "*"], exitCode: 0 };
const advertised = {
  match: ["ls-remote", "--exit-code", remoteUrl, ref],
  exitCode: 0,
  stdout: `${pullSha}\t${ref}\n`,
};
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
  stdout: `${pullSha}\n`,
};
const bundled = {
  match: [
    "--git-dir",
    "*",
    "bundle",
    "create",
    "*",
    "refs/auto-harness/pull-fetch/source",
    pullSha,
  ],
  exitCode: 0,
};
const imported = { match: ["bundle", "unbundle", "*"], exitCode: 0 };

describe("isolated GitHub pull-ref fetch", () => {
  it.each([
    ["darwin", "/dev/null"],
    ["linux", "/dev/null"],
    ["win32", "NUL"],
  ] as const)("uses the immutable null global config path on %s", (platformName, expected) => {
    expect(nullGlobalGitConfigPath(platformName)).toBe(expected);
  });

  it("ignores ordinary refs and pull refs without a pinned origin", async () => {
    const runner = scripted([]);
    await expect(fetchGitHubPullRequestRef(runner, cwd, "main", remoteUrl)).resolves.toBeNull();
    await expect(fetchGitHubPullRequestRef(runner, cwd, ref, undefined)).resolves.toBeNull();
  });

  it.each([
    ["advertisement", [{ ...advertised, exitCode: 2, stdout: "" }]],
    ["empty successful advertisement", [{ ...advertised, stdout: "" }]],
    [
      "ambiguous advertisement lines",
      [{ ...advertised, stdout: `${pullSha}\t${ref}\n${pullSha}\t${ref}\n` }],
    ],
    ["malformed advertisement", [{ ...advertised, stdout: "not-a-ref\n" }]],
    ["ambiguous advertisement", [{ ...advertised, stdout: `${pullSha}\t${ref}\tunexpected\n` }]],
    ["initialization", [advertised, { ...initialized, exitCode: 1 }]],
    ["resolution", [advertised, initialized, fetched, { ...resolved, exitCode: 1, stdout: "" }]],
    [
      "mismatched resolutions after the bounded retry",
      [
        advertised,
        initialized,
        fetched,
        { ...resolved, stdout: "f".repeat(40) },
        advertised,
        initialized,
        fetched,
        { ...resolved, stdout: "e".repeat(40) },
      ],
    ],
    ["bundle creation", [advertised, initialized, fetched, resolved, { ...bundled, exitCode: 1 }]],
    [
      "bundle import",
      [advertised, initialized, fetched, resolved, bundled, { ...imported, exitCode: 1 }],
    ],
    [
      "scratch-ref update",
      [
        advertised,
        initialized,
        fetched,
        resolved,
        bundled,
        imported,
        { match: ["update-ref", "--no-deref", "*", pullSha], exitCode: 1 },
      ],
    ],
  ])("returns null after failed %s", async (_stage, steps) => {
    await expect(
      fetchGitHubPullRequestRef(scripted(steps), cwd, ref, remoteUrl),
    ).resolves.toBeNull();
  });

  it("runs the advertised-ref transport from the administrator-owned filesystem root", async () => {
    let lsRemoteCwd: string | undefined;
    const runner = {
      async run(options: import("./executor.ts").RunProcessOptions) {
        const args = options.argv.slice(1);
        if (args[0] === "ls-remote") {
          lsRemoteCwd = options.cwd;
          options.onChunk({ stream: "stdout", data: `${pullSha}\t${ref}\n` });
          return { exitCode: 0, timedOut: false, signal: null };
        }
        if (args[0] === "init") return { exitCode: 1, timedOut: false, signal: null };
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
    };

    await expect(fetchGitHubPullRequestRef(runner, cwd, ref, remoteUrl)).resolves.toBeNull();
    expect(lsRemoteCwd).toBe(parse(tmpdir()).root);
  });

  it("re-advertises once when the pull head moves during fetch", async () => {
    const movedSha = "fedcba9876543210fedcba9876543210fedcba98";
    const destination = await fetchGitHubPullRequestRef(
      scripted([
        advertised,
        initialized,
        fetched,
        { ...resolved, stdout: `${movedSha}\n` },
        { ...advertised, stdout: `${movedSha}\t${ref}\n` },
        initialized,
        fetched,
        { ...resolved, stdout: `${movedSha}\n` },
        {
          match: [
            "--git-dir",
            "*",
            "bundle",
            "create",
            "*",
            "refs/auto-harness/pull-fetch/source",
            movedSha,
          ],
          exitCode: 0,
        },
        imported,
        { match: ["update-ref", "--no-deref", "*", movedSha], exitCode: 0 },
      ]),
      cwd,
      ref,
      remoteUrl,
    );

    expect(destination).toMatchObject({ sha: movedSha });
  });

  it("initializes the scratch repository with the checkout object format", async () => {
    await expect(
      fetchGitHubPullRequestRef(
        scripted([
          advertised,
          { ...initialized, match: ["init", "--bare", "--object-format=sha256", "*"], exitCode: 1 },
        ]),
        cwd,
        ref,
        remoteUrl,
        undefined,
        undefined,
        undefined,
        "sha256",
      ),
    ).resolves.toBeNull();
  });

  it("roots an already-present pull head without creating an empty bundle", async () => {
    const destination = await fetchGitHubPullRequestRef(
      scripted([
        advertised,
        initialized,
        fetched,
        resolved,
        {
          match: ["--git-dir", "*", "merge-base", "--is-ancestor", pullSha, "base-sha"],
          exitCode: 0,
        },
        { match: ["update-ref", "--no-deref", "*", pullSha], exitCode: 0 },
      ]),
      cwd,
      ref,
      { remoteUrl, transport: {} },
      "/srv/repository/.git/objects",
      "base-sha",
    );

    expect(destination).toMatchObject({
      ref: expect.stringMatching(/^refs\/worktree\/auto-harness\/pull-fetch\//),
      sha: pullSha,
    });
  });

  it.each([
    ["fails to root an already-present head", 0, 1],
    ["cannot determine whether a head is already present", 128, 0],
  ])("fails closed when it %s", async (_description, mergeBaseExitCode, updateRefExitCode) => {
    await expect(
      fetchGitHubPullRequestRef(
        scripted([
          advertised,
          initialized,
          fetched,
          resolved,
          {
            match: ["--git-dir", "*", "merge-base", "--is-ancestor", pullSha, "base-sha"],
            exitCode: mergeBaseExitCode,
          },
          ...(mergeBaseExitCode === 0
            ? [{ match: ["update-ref", "--no-deref", "*", pullSha], exitCode: updateRefExitCode }]
            : []),
        ]),
        cwd,
        ref,
        { remoteUrl, transport: {} },
        "/srv/repository/.git/objects",
        "base-sha",
      ),
    ).resolves.toBeNull();
  });
});
