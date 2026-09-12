/* eslint-disable max-lines -- checkout resolution, recovery, and diagnostics share one scripted Git fixture. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createGitClient } from "./git.ts";
import { fetchGitHubPullRequestRef } from "./git-github-pull-ref.ts";
import { scripted } from "../test-helpers/git-test-helpers.ts";

function resolvesCommit(ref: string, sha = "abc") {
  return {
    match: ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    exitCode: 0,
    stdout: `${sha}\n`,
  };
}

function updatesSubmodules(exitCode = 0, stderr = "") {
  return {
    match: ["submodule", "update", "--recursive", "--checkout", "--force"],
    exitCode,
    stderr,
  };
}

function syncsSubmodules(exitCode = 0, stderr = "") {
  return { match: ["submodule", "sync", "--recursive"], exitCode, stderr };
}

function lockProbe() {
  return [
    {
      match: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      exitCode: 0,
      stdout: `${join(checkoutRepo, ".git")}\n`,
    },
    {
      match: ["rev-parse", "--path-format=absolute", "--git-dir"],
      exitCode: 0,
      stdout: `${checkoutGitDir}\n`,
    },
    {
      match: ["rev-parse", "--path-format=absolute", "--git-path", "index.lock"],
      exitCode: 0,
      stdout: `${join(checkoutGitDir, "index.lock")}\n`,
    },
  ];
}

function resetsPriorState() {
  return [...lockProbe(), { match: ["ls-files", "-v", "-z"], exitCode: 0 }];
}

function hardReset(sha: string) {
  return { match: ["reset", "--hard", sha], exitCode: 0 };
}

function capturesOrigin(url = "https://github.com/example/repository.git") {
  return { match: ["remote", "get-url", "--", "origin"], exitCode: 0, stdout: `${url}\n` };
}

function fetchesGitHubPullRef(
  ref: string,
  remoteUrl = "https://github.com/example/repository.git",
) {
  return [
    { match: ["init", "--bare", "*"], exitCode: 0 },
    {
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
    },
    {
      match: [
        "--git-dir",
        "*",
        "rev-parse",
        "--verify",
        "refs/auto-harness/pull-fetch/source^{commit}",
      ],
      exitCode: 0,
      stdout: "pr-sha\n",
    },
    {
      match: ["--git-dir", "*", "bundle", "create", "*", "refs/auto-harness/pull-fetch/source"],
      exitCode: 0,
    },
    { match: ["bundle", "unbundle", "*"], exitCode: 0 },
    { match: ["update-ref", "--no-deref", "*", "pr-sha"], exitCode: 0 },
  ];
}

function resolvesFetchedPullRef(sha = "pr-sha") {
  return {
    match: ["rev-parse", "--verify", "--end-of-options", "*"],
    exitCode: 0,
    stdout: `${sha}\n`,
  };
}

function deletesFetchedPullRef(exitCode = 0) {
  return { match: ["update-ref", "--no-deref", "-d", "*"], exitCode };
}

const checkoutRoot = mkdtempSync(join(tmpdir(), "ah-git-checkout-unit-"));
const checkoutRepo = join(checkoutRoot, "repo");
const checkoutCwd = join(checkoutRoot, "wt");
const checkoutGitDir = join(checkoutRepo, ".git", "worktrees", "one");

beforeAll(() => {
  mkdirSync(checkoutCwd, { recursive: true });
  mkdirSync(checkoutGitDir, { recursive: true });
  writeFileSync(join(checkoutCwd, ".git"), `gitdir: ${checkoutGitDir}\n`);
  writeFileSync(join(checkoutGitDir, "gitdir"), `${join(checkoutCwd, ".git")}\n`);
});

afterAll(() => {
  rmSync(checkoutRoot, { recursive: true, force: true });
});

describe("createGitClient checkout and revParse", () => {
  it("fetches a pinned pull URL with mutable URL-rewrite configuration isolated", async () => {
    let fetchEnvironment: NodeJS.ProcessEnv | undefined;
    const runner = {
      async run(options: import("./executor.ts").RunProcessOptions) {
        const args = options.argv.slice(1);
        if (args[0] === "init") {
          return { exitCode: 0, timedOut: false, signal: null };
        }
        if (args.includes("fetch")) {
          fetchEnvironment = options.env;
          return { exitCode: 1, timedOut: false, signal: null };
        }
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
    };

    await expect(
      fetchGitHubPullRequestRef(
        runner,
        checkoutCwd,
        "refs/pull/130/head",
        "https://github.com/example/repository.git",
      ),
    ).resolves.toBeNull();
    expect(fetchEnvironment?.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(fetchEnvironment?.GIT_CONFIG_GLOBAL).toContain("auto-harness-pull-fetch-");
    expect(fetchEnvironment).not.toHaveProperty("GIT_CONFIG_COUNT");
  });

  it("checkoutRef detaches at resolved sha", async () => {
    const git = createGitClient(
      scripted([
        ...resetsPriorState(),
        resolvesCommit("main", "abc123"),
        { match: ["switch", "--discard-changes", "--detach", "abc123"], exitCode: 0 },
        hardReset("abc123"),
        syncsSubmodules(),
        updatesSubmodules(),
        { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "abc123\n" },
        { match: ["symbolic-ref", "--quiet", "HEAD"], exitCode: 1 },
      ]),
    );
    await git.checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref: "main" });
  });

  it("checkoutRef fetches then falls back to checkout --detach", async () => {
    const git = createGitClient(
      scripted([
        ...resetsPriorState(),
        {
          match: ["rev-parse", "--verify", "--end-of-options", "main^{commit}"],
          exitCode: 1,
          stderr: "no",
        },
        { match: ["fetch", "--all", "--tags"], exitCode: 0 },
        resolvesCommit("main"),
        {
          match: ["switch", "--discard-changes", "--detach", "abc"],
          exitCode: 1,
          stderr: "old git",
        },
        { match: ["checkout", "--force", "--detach", "abc"], exitCode: 0 },
        hardReset("abc"),
        syncsSubmodules(),
        updatesSubmodules(),
        { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "abc\n" },
        { match: ["symbolic-ref", "--quiet", "HEAD"], exitCode: 1 },
      ]),
    );
    await git.checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref: "main" });
  });

  it("checkoutRef fetches an exact GitHub pull-request ref without shared FETCH_HEAD", async () => {
    const ref = "refs/pull/123/head";
    const remoteUrl = "https://github.com/example/repository.git";
    const git = createGitClient(
      scripted([
        ...resetsPriorState(),
        capturesOrigin(remoteUrl),
        ...fetchesGitHubPullRef(ref, remoteUrl),
        resolvesFetchedPullRef(),
        { match: ["switch", "--discard-changes", "--detach", "pr-sha"], exitCode: 0 },
        hardReset("pr-sha"),
        syncsSubmodules(),
        updatesSubmodules(),
        { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "pr-sha\n" },
        { match: ["symbolic-ref", "--quiet", "HEAD"], exitCode: 1 },
        deletesFetchedPullRef(),
      ]),
    );

    await expect(
      git.checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref }),
    ).resolves.toBe("pr-sha");
  });

  it("uses restart-stable operator policy, object reuse, safe transport, and replacement-free Git", async () => {
    const ref = "refs/pull/126/head";
    const remoteUrl = "https://github.com/example/repository.git";
    let fetchEnvironment: NodeJS.ProcessEnv | undefined;
    const steps = [
      ...resetsPriorState(),
      {
        match: ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
        exitCode: 0,
        stdout: `${join(checkoutRepo, ".git", "objects")}\n`,
      },
      { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "base-sha\n" },
      { match: ["init", "--bare", "*"], exitCode: 0 },
      {
        match: [
          "-c",
          "credential.helper=manager-core",
          "-c",
          "http.proxy=https://proxy.example",
          "-c",
          "http.sslCAInfo=/etc/ssl/private-ca.pem",
          "--git-dir",
          "*",
          "fetch",
          "--no-write-fetch-head",
          "--no-tags",
          remoteUrl,
          `+${ref}:refs/auto-harness/pull-fetch/source`,
        ],
        exitCode: 0,
      },
      {
        match: [
          "--git-dir",
          "*",
          "rev-parse",
          "--verify",
          "refs/auto-harness/pull-fetch/source^{commit}",
        ],
        exitCode: 0,
        stdout: "pr-sha\n",
      },
      {
        match: [
          "--git-dir",
          "*",
          "bundle",
          "create",
          "*",
          "refs/auto-harness/pull-fetch/source",
          "^base-sha",
        ],
        exitCode: 0,
      },
      { match: ["bundle", "unbundle", "*"], exitCode: 0 },
      { match: ["update-ref", "--no-deref", "*", "pr-sha"], exitCode: 0 },
      resolvesFetchedPullRef(),
      { match: ["switch", "--discard-changes", "--detach", "pr-sha"], exitCode: 0 },
      hardReset("pr-sha"),
      syncsSubmodules(),
      updatesSubmodules(),
      { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "pr-sha\n" },
      { match: ["symbolic-ref", "--quiet", "HEAD"], exitCode: 1 },
      deletesFetchedPullRef(),
    ];
    const runner = scripted(steps);
    const originalRun = runner.run.bind(runner);
    runner.run = async (options) => {
      if (options.argv.slice(1).includes("fetch")) fetchEnvironment = options.env;
      return originalRun(options);
    };
    const git = createGitClient(
      runner,
      new Map([
        [
          resolve(checkoutRepo),
          {
            remoteUrl,
            transport: {
              credentialHelper: "manager-core",
              httpProxy: "https://proxy.example",
              sslCAInfo: "/etc/ssl/private-ca.pem",
            },
          },
        ],
      ]),
    );
    await git.checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref });
    expect(fetchEnvironment).toMatchObject({
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(checkoutRepo, ".git", "objects"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
    });
  });

  it("uses the origin URL captured before an untrusted session can mutate repository config", async () => {
    const ref = "refs/pull/124/head";
    const remoteUrl = "https://github.com/example/repository.git";
    const mutatedUrl = "https://attacker.example/other.git";
    const git = createGitClient(
      scripted([
        { match: ["rev-parse", "--is-inside-work-tree"], exitCode: 0, stdout: "true\n" },
        capturesOrigin(remoteUrl),
        // If checkoutRef re-reads mutable config, this response would replace the pinned URL and
        // make the expected fetch below fail.
        capturesOrigin(mutatedUrl),
        ...resetsPriorState(),
        ...fetchesGitHubPullRef(ref, remoteUrl),
        resolvesFetchedPullRef("pinned-pr-sha"),
        { match: ["switch", "--discard-changes", "--detach", "pinned-pr-sha"], exitCode: 0 },
        hardReset("pinned-pr-sha"),
        syncsSubmodules(),
        updatesSubmodules(),
        { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "pinned-pr-sha\n" },
        { match: ["symbolic-ref", "--quiet", "HEAD"], exitCode: 1 },
        deletesFetchedPullRef(),
      ]),
    );

    await git.ensureRepo(checkoutRepo);
    await expect(
      git.checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref }),
    ).resolves.toBe("pinned-pr-sha");
  });

  it("uses a fresh per-worktree scratch ref rather than inspecting a shared predictable ref", async () => {
    const ref = "refs/pull/125/head";
    const git = createGitClient(
      scripted([
        ...resetsPriorState(),
        capturesOrigin(),
        ...fetchesGitHubPullRef(ref),
        resolvesFetchedPullRef(),
        { match: ["switch", "--discard-changes", "--detach", "pr-sha"], exitCode: 0 },
        hardReset("pr-sha"),
        syncsSubmodules(),
        updatesSubmodules(),
        { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "pr-sha\n" },
        { match: ["symbolic-ref", "--quiet", "HEAD"], exitCode: 1 },
        deletesFetchedPullRef(),
      ]),
    );

    await expect(
      git.checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref }),
    ).resolves.toBe("pr-sha");
  });

  it("fails closed when no immutable origin URL is available", async () => {
    const ref = "refs/pull/127/head";
    const checkout = createGitClient(
      scripted([
        ...resetsPriorState(),
        { match: ["remote", "get-url", "--", "origin"], exitCode: 1 },
      ]),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref });

    await expect(checkout).rejects.toThrow("Failed to fetch GitHub pull-request ref");
  });

  it("fails closed when the captured origin URL is empty", async () => {
    const ref = "refs/pull/128/head";
    const checkout = createGitClient(
      scripted([
        ...resetsPriorState(),
        { match: ["remote", "get-url", "--", "origin"], exitCode: 0 },
      ]),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref });

    await expect(checkout).rejects.toThrow("Failed to fetch GitHub pull-request ref");
  });

  it("pins unavailable origin capture instead of accepting an origin added by an untrusted session", async () => {
    const ref = "refs/pull/129/head";
    const git = createGitClient(
      scripted([
        { match: ["rev-parse", "--is-inside-work-tree"], exitCode: 0, stdout: "true\n" },
        { match: ["remote", "get-url", "--", "origin"], exitCode: 1 },
        ...resetsPriorState(),
      ]),
    );

    await git.ensureRepo(checkoutRepo);
    await expect(
      git.checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref }),
    ).rejects.toThrow("Failed to fetch GitHub pull-request ref");
  });

  it("checkoutRef fails closed instead of probing an untrusted fallback remote", async () => {
    const ref = "refs/pull/7/head";
    const git = createGitClient(
      scripted([
        ...resetsPriorState(),
        capturesOrigin(),
        { match: ["init", "--bare", "*"], exitCode: 0 },
        {
          match: [
            "--git-dir",
            "*",
            "fetch",
            "--no-write-fetch-head",
            "--no-tags",
            "https://github.com/example/repository.git",
            `+${ref}:refs/auto-harness/pull-fetch/source`,
          ],
          exitCode: 1,
        },
      ]),
    );

    await expect(
      git.checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref }),
    ).rejects.toThrow("Failed to fetch GitHub pull-request ref refs/pull/7/head");
  });

  it("checkoutRef fails closed when no remote exposes a GitHub pull-request ref", async () => {
    const ref = "refs/pull/8/head";
    const checkout = createGitClient(
      scripted([
        ...resetsPriorState(),
        capturesOrigin(),
        { match: ["init", "--bare", "*"], exitCode: 0 },
        {
          match: [
            "--git-dir",
            "*",
            "fetch",
            "--no-write-fetch-head",
            "--no-tags",
            "https://github.com/example/repository.git",
            `+${ref}:refs/auto-harness/pull-fetch/source`,
          ],
          exitCode: 1,
        },
      ]),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref });

    await expect(checkout).rejects.toThrow(
      "Failed to fetch GitHub pull-request ref refs/pull/8/head",
    );
  });

  it("checkoutRef fails closed when its bounded scratch ref cannot be deleted", async () => {
    const ref = "refs/pull/9/head";
    const checkout = createGitClient(
      scripted([
        ...resetsPriorState(),
        capturesOrigin(),
        ...fetchesGitHubPullRef(ref),
        resolvesFetchedPullRef(),
        { match: ["switch", "--discard-changes", "--detach", "pr-sha"], exitCode: 0 },
        hardReset("pr-sha"),
        syncsSubmodules(),
        updatesSubmodules(),
        { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "pr-sha\n" },
        { match: ["symbolic-ref", "--quiet", "HEAD"], exitCode: 1 },
        deletesFetchedPullRef(1),
      ]),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref });

    await expect(checkout).rejects.toThrow(
      "Failed to clean up GitHub pull-request ref refs/pull/9/head",
    );
  });

  it("cleans the scratch ref with a fresh bounded signal after the session signal aborts", async () => {
    const ref = "refs/pull/10/head";
    const controller = new AbortController();
    let cleanupAborted: boolean | undefined;
    const runner = scripted([
      ...resetsPriorState(),
      capturesOrigin(),
      ...fetchesGitHubPullRef(ref),
      resolvesFetchedPullRef(),
      { match: ["switch", "--discard-changes", "--detach", "pr-sha"], exitCode: 0 },
      hardReset("pr-sha"),
      syncsSubmodules(),
      updatesSubmodules(),
      { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "pr-sha\n" },
      { match: ["symbolic-ref", "--quiet", "HEAD"], exitCode: 1 },
      deletesFetchedPullRef(),
    ]);
    const originalRun = runner.run.bind(runner);
    runner.run = async (options) => {
      const args = options.argv.slice(1);
      const result = await originalRun(options);
      if (args[0] === "symbolic-ref") controller.abort();
      if (args[0] === "update-ref" && args.includes("-d")) cleanupAborted = options.signal?.aborted;
      return result;
    };
    await createGitClient(runner).checkoutRef({
      cwd: checkoutCwd,
      repoPath: checkoutRepo,
      ref,
      signal: controller.signal,
    });
    expect(cleanupAborted).toBe(false);
  });

  it("checkoutRef retries when an index lock appears after preparation", async () => {
    const git = createGitClient(
      scripted([
        ...resetsPriorState(),
        resolvesCommit("main"),
        {
          match: ["switch", "--discard-changes", "--detach", "abc"],
          exitCode: 1,
          stderr: "index.lock exists",
        },
        {
          match: ["checkout", "--force", "--detach", "abc"],
          exitCode: 1,
          stderr: "index.lock exists",
        },
        ...lockProbe(),
        { match: ["switch", "--discard-changes", "--detach", "abc"], exitCode: 0 },
        hardReset("abc"),
        syncsSubmodules(),
        updatesSubmodules(),
        { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "abc\n" },
        { match: ["symbolic-ref", "--quiet", "HEAD"], exitCode: 1 },
      ]),
    );

    await expect(
      git.checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref: "main" }),
    ).resolves.toBe("abc");
  });

  it("checkoutRef fails when the hard reset cannot restore tracked files", async () => {
    const checkout = createGitClient(
      scripted([
        ...resetsPriorState(),
        resolvesCommit("main"),
        { match: ["switch", "--discard-changes", "--detach", "abc"], exitCode: 0 },
        { match: ["reset", "--hard", "abc"], exitCode: 1, stderr: "reset failed" },
        { match: ["fsck", "--connectivity-only", "abc"], exitCode: 0 },
      ]),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref: "main" });

    await expect(checkout).rejects.toThrow("Failed to checkout resolved ref: reset failed");
  });

  it("checkoutRef rejects an identity changed after the initial preflight", async () => {
    let call = 0;
    const runner = {
      async run(options: import("./executor.ts").RunProcessOptions) {
        call += 1;
        if (call === 1) writeFileSync(join(checkoutGitDir, "gitdir"), "/different/.git\n");
        if (options.argv.includes("--git-common-dir")) {
          options.onChunk({ stream: "stdout", data: `${join(checkoutRepo, ".git")}\n` });
        } else if (options.argv.includes("--git-dir")) {
          options.onChunk({ stream: "stdout", data: `${checkoutGitDir}\n` });
        } else if (options.argv.includes("index.lock")) {
          options.onChunk({ stream: "stdout", data: `${join(checkoutGitDir, "index.lock")}\n` });
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };

    try {
      await expect(
        createGitClient(runner).checkoutRef({
          cwd: checkoutCwd,
          repoPath: checkoutRepo,
          ref: "main",
        }),
      ).rejects.toThrow("Configured checkout is not the claimed linked worktree");
    } finally {
      writeFileSync(join(checkoutGitDir, "gitdir"), `${join(checkoutCwd, ".git")}\n`);
    }
  });

  it("checkoutRef fails when ref cannot be resolved", async () => {
    await expect(
      createGitClient(
        scripted([
          ...resetsPriorState(),
          {
            match: ["rev-parse", "--verify", "--end-of-options", "bad^{commit}"],
            exitCode: 1,
            stderr: "e",
          },
          { match: ["fetch", "--all", "--tags"], exitCode: 0 },
          {
            match: ["rev-parse", "--verify", "--end-of-options", "bad^{commit}"],
            exitCode: 1,
            stderr: "e2",
          },
        ]),
      ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref: "bad" }),
    ).rejects.toThrow(/Failed to resolve ref/);
  });

  it("checkoutRef peels an annotated tag to its commit", async () => {
    const git = createGitClient(
      scripted([
        ...resetsPriorState(),
        resolvesCommit("v1.2.3", "commit-sha"),
        {
          match: ["switch", "--discard-changes", "--detach", "commit-sha"],
          exitCode: 0,
        },
        hardReset("commit-sha"),
        syncsSubmodules(),
        updatesSubmodules(),
        { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "commit-sha\n" },
        { match: ["symbolic-ref", "--quiet", "HEAD"], exitCode: 1 },
      ]),
    );

    await expect(
      git.checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref: "v1.2.3" }),
    ).resolves.toBe("commit-sha");
  });

  it("checkoutRef retries once after a target graph connectivity failure", async () => {
    const git = createGitClient(
      scripted([
        ...resetsPriorState(),
        resolvesCommit("main"),
        {
          match: ["switch", "--discard-changes", "--detach", "abc"],
          exitCode: 1,
          stderr: "missing tree",
        },
        {
          match: ["checkout", "--force", "--detach", "abc"],
          exitCode: 1,
          stderr: "missing tree",
        },
        { match: ["fsck", "--connectivity-only", "abc"], exitCode: 1, stderr: "missing tree" },
        { match: ["remote"], exitCode: 0, stdout: "origin\nupstream\n" },
        {
          match: ["fetch", "--tags", "--refetch", "origin"],
          exitCode: 0,
        },
        { match: ["fetch", "--tags", "--refetch", "upstream"], exitCode: 0 },
        { match: ["switch", "--discard-changes", "--detach", "abc"], exitCode: 0 },
        hardReset("abc"),
        syncsSubmodules(),
        updatesSubmodules(),
        { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "abc\n" },
        { match: ["symbolic-ref", "--quiet", "HEAD"], exitCode: 1 },
      ]),
    );
    await expect(
      git.checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref: "main" }),
    ).resolves.toBe("abc");
  });

  it("checkoutRef does not refetch after an unrelated checkout failure", async () => {
    const checkout = createGitClient(
      scripted([
        ...resetsPriorState(),
        resolvesCommit("main"),
        {
          match: ["switch", "--discard-changes", "--detach", "abc"],
          exitCode: 1,
          stderr: "dirty worktree",
        },
        {
          match: ["checkout", "--force", "--detach", "abc"],
          exitCode: 1,
          stderr: "dirty worktree",
        },
        { match: ["fsck", "--connectivity-only", "abc"], exitCode: 0 },
      ]),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref: "main" });

    await expect(checkout).rejects.toThrow("Failed to checkout resolved ref");
  });

  it("checkoutRef fails closed when a remote refetch fails", async () => {
    const checkout = createGitClient(
      scripted([
        ...resetsPriorState(),
        resolvesCommit("main"),
        { match: ["switch", "--discard-changes", "--detach", "abc"], exitCode: 1, stderr: "s" },
        { match: ["checkout", "--force", "--detach", "abc"], exitCode: 1, stderr: "c" },
        { match: ["fsck", "--connectivity-only", "abc"], exitCode: 1, stderr: "missing tree" },
        { match: ["remote"], exitCode: 0, stdout: "origin\n" },
        {
          match: ["fetch", "--tags", "--refetch", "origin"],
          exitCode: 1,
          stderr: "fatal: https://oauth:secret-token@example.com/repo.git",
        },
      ]),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref: "main" });
    const error = await checkout.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Failed to fetch required checkout objects");
    expect((error as Error).message).not.toContain("secret-token");
  });

  it("checkoutRef fails after one missing-object recovery attempt", async () => {
    const checkout = createGitClient(
      scripted([
        ...resetsPriorState(),
        resolvesCommit("main"),
        {
          match: ["switch", "--discard-changes", "--detach", "abc"],
          exitCode: 1,
          stderr: "first switch",
        },
        {
          match: ["checkout", "--force", "--detach", "abc"],
          exitCode: 1,
          stderr: "first checkout",
        },
        { match: ["fsck", "--connectivity-only", "abc"], exitCode: 1, stderr: "missing tree" },
        { match: ["remote"], exitCode: 0, stdout: "origin\n" },
        { match: ["fetch", "--tags", "--refetch", "origin"], exitCode: 0 },
        {
          match: ["switch", "--discard-changes", "--detach", "abc"],
          exitCode: 1,
          stderr: "second switch",
        },
        {
          match: ["checkout", "--force", "--detach", "abc"],
          exitCode: 1,
          stderr:
            "fatal: unable to checkout https://oauth:secret-token@example.com/repo.git: credential rejected",
        },
      ]),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref: "main" });
    const error = await checkout.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Failed to checkout resolved ref");
    expect((error as Error).message).toContain("credential rejected");
    expect((error as Error).message).not.toContain("secret-token");
  });

  it("checkoutRef fails closed when detached HEAD resolves to a different SHA", async () => {
    const checkout = createGitClient(
      scripted([
        ...resetsPriorState(),
        resolvesCommit("main"),
        { match: ["switch", "--discard-changes", "--detach", "abc"], exitCode: 0 },
        hardReset("abc"),
        syncsSubmodules(),
        updatesSubmodules(),
        {
          match: ["rev-parse", "HEAD"],
          exitCode: 0,
          stdout: "different-sha\n",
        },
      ]),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref: "main" });
    const error = await checkout.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Failed to verify detached checkout");
    expect((error as Error).message).not.toContain("different-sha");
  });

  it("checkoutRef fails closed when HEAD remains attached at the resolved SHA", async () => {
    const checkout = createGitClient(
      scripted([
        ...resetsPriorState(),
        resolvesCommit("main"),
        { match: ["switch", "--discard-changes", "--detach", "abc"], exitCode: 0 },
        hardReset("abc"),
        syncsSubmodules(),
        updatesSubmodules(),
        { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "abc\n" },
        { match: ["symbolic-ref", "--quiet", "HEAD"], exitCode: 0, stdout: "refs/heads/main\n" },
      ]),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref: "main" });

    await expect(checkout).rejects.toThrow("Failed to verify detached checkout");
  });

  it("checkoutRef reports a sanitized initialized-submodule reset failure", async () => {
    const checkout = createGitClient(
      scripted([
        ...resetsPriorState(),
        resolvesCommit("main"),
        { match: ["switch", "--discard-changes", "--detach", "abc"], exitCode: 0 },
        hardReset("abc"),
        syncsSubmodules(),
        updatesSubmodules(1, "fatal: ?X-Amz-Signature=SIGNEDSECRET"),
      ]),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref: "main" });

    await expect(checkout).rejects.toThrow("Failed to update submodules");
    await expect(checkout).rejects.not.toThrow("SIGNEDSECRET");
  });

  it("checkoutRef reports a sanitized submodule URL sync failure", async () => {
    const checkout = createGitClient(
      scripted([
        ...resetsPriorState(),
        resolvesCommit("main"),
        { match: ["switch", "--discard-changes", "--detach", "abc"], exitCode: 0 },
        hardReset("abc"),
        syncsSubmodules(1, "fatal: client_secret=SYNCSECRET"),
      ]),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref: "main" });

    await expect(checkout).rejects.toThrow("Failed to sync submodules");
    await expect(checkout).rejects.not.toThrow("SYNCSECRET");
  });

  it("revParse returns hash", async () => {
    const git = createGitClient(
      scripted([{ match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "abc123\n" }]),
    );
    await expect(git.revParse("/repo", "HEAD")).resolves.toBe("abc123");
  });

  it("forwards an abort signal while resolving a revision", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const git = createGitClient({
      async run(options) {
        seen = options.signal;
        options.onChunk({ stream: "stdout", data: "abc123\n" });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    });

    await expect(git.revParse("/repo", "HEAD", controller.signal)).resolves.toBe("abc123");
    expect(seen).toBe(controller.signal);
  });

  it("forwards a session abort signal to every checkout command", async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const git = createGitClient({
      async run(options) {
        if (options.signal) seen.push(options.signal);
        if (options.argv[1] === "symbolic-ref") {
          return { exitCode: 1, timedOut: false, signal: null };
        }
        if (options.argv[1] !== "ls-files") {
          options.onChunk({ stream: "stdout", data: "abc\n" });
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    });
    await git.checkoutRef({
      cwd: checkoutCwd,
      repoPath: checkoutRepo,
      ref: "main",
      signal: controller.signal,
    });
    expect(seen).toEqual([
      controller.signal,
      controller.signal,
      controller.signal,
      controller.signal,
      controller.signal,
      controller.signal,
      controller.signal,
      controller.signal,
      controller.signal,
      controller.signal,
      controller.signal,
    ]);
  });
});
