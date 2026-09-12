/* eslint-disable max-lines -- checkout resolution, recovery, and diagnostics share one scripted Git fixture. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createGitClient } from "./git.ts";
import { fetchGitHubPullRequestRef } from "./git-github-pull-ref.ts";
import { scripted } from "../test-helpers/git-test-helpers.ts";

const pullSha = "0123456789abcdef0123456789abcdef01234567";

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

function checksPullRefSubmodules(exitCode = 0, stdout = "") {
  return { match: ["submodule", "status", "--recursive"], exitCode, stdout };
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

function pullRefPolicy(remoteUrl = "https://github.com/example/repository.git") {
  return new Map([[resolve(checkoutRepo), { remoteUrl, transport: {} }]]);
}

function pullRefCheckoutSteps(
  ref: string,
  remoteUrl = "https://github.com/example/repository.git",
  objectFormat = "sha1",
  submoduleExitCode = 0,
  deleteExitCode = 0,
) {
  return [
    ...lockProbe(),
    {
      match: ["rev-parse", "--show-object-format=storage"],
      exitCode: 0,
      stdout: `${objectFormat}\n`,
    },
    ...fetchesGitHubPullRef(ref, remoteUrl, undefined, objectFormat),
    {
      match: ["init", "--bare", `--object-format=${objectFormat}`, "*"],
      exitCode: 0,
    },
    { match: ["read-tree", "--reset", "-u", "--no-sparse-checkout", pullSha], exitCode: 0 },
    { match: ["update-ref", "--no-deref", "HEAD", pullSha], exitCode: 0 },
    checksPullRefSubmodules(submoduleExitCode),
    { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: `${pullSha}\n` },
    { match: ["symbolic-ref", "--quiet", "HEAD"], exitCode: 1 },
    deletesFetchedPullRef(deleteExitCode),
  ];
}

function advertisesGitHubPullRef(
  ref: string,
  remoteUrl = "https://github.com/example/repository.git",
) {
  return {
    match: ["ls-remote", "--exit-code", remoteUrl, ref],
    exitCode: 0,
    stdout: `${pullSha}\t${ref}\n`,
  };
}

function fetchesGitHubPullRef(
  ref: string,
  remoteUrl = "https://github.com/example/repository.git",
  baseSha: string | undefined = undefined,
  objectFormat = "sha1",
) {
  return [
    advertisesGitHubPullRef(ref, remoteUrl),
    { match: ["init", "--bare", `--object-format=${objectFormat}`, "*"], exitCode: 0 },
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
      stdout: `${pullSha}\n`,
    },
    ...(baseSha === undefined
      ? []
      : [
          {
            match: ["--git-dir", "*", "merge-base", "--is-ancestor", pullSha, baseSha],
            exitCode: 1,
          },
        ]),
    {
      match: [
        "--git-dir",
        "*",
        "bundle",
        "create",
        "*",
        "refs/auto-harness/pull-fetch/source",
        pullSha,
        ...(baseSha === undefined ? [] : [`^${baseSha}`]),
      ],
      exitCode: 0,
    },
    { match: ["bundle", "unbundle", "*"], exitCode: 0 },
    { match: ["update-ref", "--no-deref", "*", pullSha], exitCode: 0 },
  ];
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
        if (args[0] === "ls-remote") {
          options.onChunk({
            stream: "stdout",
            data: `${pullSha}\trefs/pull/130/head\n`,
          });
          return {
            exitCode: 0,
            timedOut: false,
            signal: null,
          };
        }
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
    expect(fetchEnvironment?.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(fetchEnvironment).toMatchObject({
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_KEY_2: "http.proxy",
      GIT_CONFIG_KEY_3: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_VALUE_2: "",
      GIT_CONFIG_VALUE_3: "false",
    });
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
      scripted([...pullRefCheckoutSteps(ref, remoteUrl)]),
      pullRefPolicy(remoteUrl),
    );

    await expect(
      git.checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref }),
    ).resolves.toBe(pullSha);
  });

  it("initializes the pinned pull-ref scratch repository with the checkout hash format", async () => {
    const ref = "refs/pull/132/head";
    const remoteUrl = "https://github.com/example/repository.git";
    const git = createGitClient(
      scripted([...pullRefCheckoutSteps(ref, remoteUrl, "sha256")]),
      pullRefPolicy(remoteUrl),
    );

    await expect(
      git.checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref }),
    ).resolves.toBe(pullSha);
  });

  it("uses restart-stable operator policy and isolated pull-ref materialization", async () => {
    const ref = "refs/pull/126/head";
    const remoteUrl = "https://github.com/example/repository.git";
    let fetchEnvironment: NodeJS.ProcessEnv | undefined;
    let materializationEnvironment: NodeJS.ProcessEnv | undefined;
    const steps = [
      ...lockProbe(),
      {
        match: ["rev-parse", "--show-object-format=storage"],
        exitCode: 0,
        stdout: "sha1\n",
      },
      {
        match: [
          "-c",
          "credential.helper=manager-core",
          "-c",
          "http.proxy=https://proxy.example",
          "-c",
          "http.sslCAInfo=/etc/ssl/private-ca.pem",
          "ls-remote",
          "--exit-code",
          remoteUrl,
          ref,
        ],
        exitCode: 0,
        stdout: `${pullSha}\t${ref}\n`,
      },
      { match: ["init", "--bare", "--object-format=sha1", "*"], exitCode: 0 },
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
        stdout: `${pullSha}\n`,
      },
      {
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
      },
      { match: ["bundle", "unbundle", "*"], exitCode: 0 },
      { match: ["update-ref", "--no-deref", "*", pullSha], exitCode: 0 },
      { match: ["init", "--bare", "--object-format=sha1", "*"], exitCode: 0 },
      { match: ["read-tree", "--reset", "-u", "--no-sparse-checkout", pullSha], exitCode: 0 },
      { match: ["update-ref", "--no-deref", "HEAD", pullSha], exitCode: 0 },
      checksPullRefSubmodules(),
      { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: `${pullSha}\n` },
      { match: ["symbolic-ref", "--quiet", "HEAD"], exitCode: 1 },
      deletesFetchedPullRef(),
    ];
    const runner = scripted(steps);
    const originalRun = runner.run.bind(runner);
    runner.run = async (options) => {
      if (options.argv.slice(1).includes("fetch")) fetchEnvironment = options.env;
      if (options.argv.slice(1)[0] === "read-tree") materializationEnvironment = options.env;
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
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_CONFIG_KEY_3: "core.fsmonitor",
      GIT_CONFIG_VALUE_3: "false",
    });
    expect(materializationEnvironment).toMatchObject({
      GIT_CONFIG_COUNT: "6",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_KEY_2: "http.proxy",
      GIT_CONFIG_KEY_3: "core.fsmonitor",
      GIT_CONFIG_KEY_4: "core.sparseCheckout",
      GIT_CONFIG_KEY_5: "core.bare",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_VALUE_3: "false",
      GIT_CONFIG_VALUE_4: "false",
      GIT_CONFIG_VALUE_5: "false",
      GIT_DIR: expect.stringMatching(/auto-harness-pull-checkout-/),
      GIT_INDEX_FILE: expect.stringMatching(/repo\/\.git\/worktrees\/one\/index$/),
      GIT_NO_REPLACE_OBJECTS: "1",
    });
  });

  it("fetches a complete pull head before isolated materialization", async () => {
    const ref = "refs/pull/131/head";
    const remoteUrl = "https://github.com/example/repository.git";
    let fetchEnvironment: NodeJS.ProcessEnv | undefined;
    const runner = scripted([...pullRefCheckoutSteps(ref, remoteUrl)]);
    const originalRun = runner.run.bind(runner);
    runner.run = async (options) => {
      if (options.argv.slice(1).includes("fetch")) fetchEnvironment = options.env;
      return originalRun(options);
    };

    await createGitClient(runner, pullRefPolicy(remoteUrl)).checkoutRef({
      cwd: checkoutCwd,
      repoPath: checkoutRepo,
      ref,
    });

    expect(fetchEnvironment).not.toHaveProperty("GIT_ALTERNATE_OBJECT_DIRECTORIES");
  });

  it("fails closed before pull-ref materialization with interrupted worktree state", async () => {
    const ref = "refs/pull/134/head";
    const marker = join(checkoutGitDir, "MERGE_HEAD");
    writeFileSync(marker, "interrupted\n");
    try {
      const checkout = createGitClient(scripted([]), pullRefPolicy()).checkoutRef({
        cwd: checkoutCwd,
        repoPath: checkoutRepo,
        ref,
      });

      await expect(checkout).rejects.toThrow("interrupted worktree state");
    } finally {
      rmSync(marker, { force: true });
    }
  });

  it("fails closed when a pull-ref checkout cannot inspect submodules", async () => {
    const ref = "refs/pull/135/head";
    const checkout = createGitClient(
      scripted([...pullRefCheckoutSteps(ref, undefined, "sha1", 1)]),
      pullRefPolicy(),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref });

    await expect(checkout).rejects.toThrow("Configured pull-ref checkout contains submodules");
  });

  it("fails closed before recovery when the repository has no pull-ref policy", async () => {
    const ref = "refs/pull/127/head";
    const checkout = createGitClient(
      scripted([
        ...resetsPriorState(),
        {
          match: ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
          exitCode: 0,
          stdout: `${join(checkoutRepo, ".git", "objects")}\n`,
        },
        { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "base-sha\n" },
      ]),
      new Map(),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref });

    await expect(checkout).rejects.toThrow("no operator policy");
  });

  it("does not recover a failed isolated pull-ref materialization through mutable remotes", async () => {
    const ref = "refs/pull/130/head";
    const checkout = createGitClient(
      scripted([
        ...lockProbe(),
        { match: ["rev-parse", "--show-object-format=storage"], exitCode: 0, stdout: "sha1\n" },
        ...fetchesGitHubPullRef(ref),
        { match: ["init", "--bare", "--object-format=sha1", "*"], exitCode: 0 },
        { match: ["read-tree", "--reset", "-u", "--no-sparse-checkout", pullSha], exitCode: 1 },
        deletesFetchedPullRef(),
      ]),
      pullRefPolicy(),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref });

    await expect(checkout).rejects.toThrow("Failed to materialize GitHub pull-request ref");
  });

  it("uses a pinned policy URL without consulting mutable repository configuration", async () => {
    const ref = "refs/pull/124/head";
    const remoteUrl = "https://github.com/example/repository.git";
    const git = createGitClient(
      scripted([...pullRefCheckoutSteps(ref, remoteUrl)]),
      pullRefPolicy(remoteUrl),
    );

    await expect(
      git.checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref }),
    ).resolves.toBe(pullSha);
  });

  it("uses a fresh per-worktree scratch ref rather than inspecting a shared predictable ref", async () => {
    const ref = "refs/pull/125/head";
    const git = createGitClient(scripted([...pullRefCheckoutSteps(ref)]), pullRefPolicy());

    await expect(
      git.checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref }),
    ).resolves.toBe(pullSha);
  });

  it("fails closed when no immutable pull-ref policy is available", async () => {
    const ref = "refs/pull/127/head";
    const checkout = createGitClient(
      scripted([
        ...resetsPriorState(),
        { match: ["remote", "get-url", "--", "origin"], exitCode: 1 },
      ]),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref });

    await expect(checkout).rejects.toThrow("no operator policy");
  });

  it("fails closed when no pull-ref policy is available before a Git config read", async () => {
    const ref = "refs/pull/128/head";
    const checkout = createGitClient(
      scripted([
        ...resetsPriorState(),
        { match: ["remote", "get-url", "--", "origin"], exitCode: 0 },
      ]),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref });

    await expect(checkout).rejects.toThrow("no operator policy");
  });

  it("does not accept an origin added by an untrusted session without operator policy", async () => {
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
    ).rejects.toThrow("no operator policy");
  });

  it("checkoutRef fails closed instead of probing an untrusted fallback remote", async () => {
    const ref = "refs/pull/7/head";
    const git = createGitClient(
      scripted([
        ...lockProbe(),
        { match: ["rev-parse", "--show-object-format=storage"], exitCode: 0, stdout: "sha1\n" },
        advertisesGitHubPullRef(ref),
        { match: ["init", "--bare", "--object-format=sha1", "*"], exitCode: 0 },
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
      pullRefPolicy(),
    );

    await expect(
      git.checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref }),
    ).rejects.toThrow("Failed to fetch GitHub pull-request ref refs/pull/7/head");
  });

  it("checkoutRef fails closed when no remote exposes a GitHub pull-request ref", async () => {
    const ref = "refs/pull/8/head";
    const checkout = createGitClient(
      scripted([
        ...lockProbe(),
        { match: ["rev-parse", "--show-object-format=storage"], exitCode: 0, stdout: "sha1\n" },
        advertisesGitHubPullRef(ref),
        { match: ["init", "--bare", "--object-format=sha1", "*"], exitCode: 0 },
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
      pullRefPolicy(),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref });

    await expect(checkout).rejects.toThrow(
      "Failed to fetch GitHub pull-request ref refs/pull/8/head",
    );
  });

  it("checkoutRef fails closed when its bounded scratch ref cannot be deleted", async () => {
    const ref = "refs/pull/9/head";
    const checkout = createGitClient(
      scripted([...pullRefCheckoutSteps(ref, undefined, "sha1", 0, 1)]),
      pullRefPolicy(),
    ).checkoutRef({ cwd: checkoutCwd, repoPath: checkoutRepo, ref });

    await expect(checkout).rejects.toThrow(
      "Failed to clean up GitHub pull-request ref refs/pull/9/head",
    );
  });

  it("cleans the scratch ref with a fresh bounded signal after the session signal aborts", async () => {
    const ref = "refs/pull/10/head";
    const controller = new AbortController();
    let cleanupAborted: boolean | undefined;
    const runner = scripted([...pullRefCheckoutSteps(ref)]);
    const originalRun = runner.run.bind(runner);
    runner.run = async (options) => {
      const args = options.argv.slice(1);
      const result = await originalRun(options);
      if (args[0] === "symbolic-ref") controller.abort();
      if (args[0] === "update-ref" && args.includes("-d")) cleanupAborted = options.signal?.aborted;
      return result;
    };
    await createGitClient(runner, pullRefPolicy()).checkoutRef({
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
