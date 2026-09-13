/* eslint-disable max-lines -- failure modes and race regressions share one scripted transfer fixture. */
import { tmpdir } from "node:os";
import { parse } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ failNextTemporaryDirectoryRemoval: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      if (state.failNextTemporaryDirectoryRemoval) {
        state.failNextTemporaryDirectoryRemoval = false;
        await actual.rm(...args);
        throw new Error("temporary directory cleanup failed");
      }
      return actual.rm(...args);
    }),
  };
});

import { CheckoutFetchError } from "./git-commands.ts";
import {
  deleteGitHubPullRequestRef,
  fetchGitHubPullRequestRef,
  materializeGitHubPullRequestRef,
  nullGlobalGitConfigPath,
} from "./git-github-pull-ref.ts";
import { scripted } from "../test-helpers/git-test-helpers.ts";

const cwd = "/tmp/auto-harness-github-pull-ref-test";
const remoteUrl = "https://github.com/example/repository.git";
const ref = "refs/pull/42/head";
const pullSha = "0123456789abcdef0123456789abcdef01234567";
const baseSha = "89abcdef0123456789abcdef0123456789abcdef";
const objectDirectory = "/srv/repository/.git/objects";

const initialized = { match: ["init", "--bare", "--object-format=sha1", "*"], exitCode: 0 };
const advertised = {
  match: ["ls-remote", "--exit-code", remoteUrl, ref, "HEAD"],
  exitCode: 0,
  stdout: `${pullSha}\t${ref}\n${baseSha}\tHEAD\n`,
};
const shallow = { match: ["rev-parse", "--is-shallow-repository"], exitCode: 0, stdout: "false\n" };
const notPartial = {
  match: ["config", "--local", "--get", "extensions.partialClone"],
  exitCode: 1,
};
const notPromisor = {
  match: ["config", "--local", "--get-regexp", "^remote\\..*\\.promisor$"],
  exitCode: 1,
};
const basePresent = {
  match: ["--git-dir", "*", "cat-file", "-e", `${baseSha}^{commit}`],
  exitCode: 0,
};
const fetched = {
  match: [
    "--git-dir",
    "*",
    "fetch",
    "--no-write-fetch-head",
    "--no-tags",
    `--negotiation-tip=${baseSha}`,
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
const commonBase = {
  match: ["--git-dir", "*", "merge-base", pullSha, baseSha],
  exitCode: 0,
  stdout: `${baseSha}\n`,
};
const pullNotPresent = {
  match: ["--git-dir", "*", "merge-base", "--is-ancestor", pullSha, baseSha],
  exitCode: 1,
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
    `^${baseSha}`,
  ],
  exitCode: 0,
};
const imported = { match: ["bundle", "unbundle", "*"], exitCode: 0 };

afterEach(() => {
  state.failNextTemporaryDirectoryRemoval = false;
});

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

  it("classifies a failed pull-ref advertisement as a checkout fetch failure", async () => {
    await expect(
      fetchGitHubPullRequestRef(
        scripted([
          shallow,
          notPartial,
          notPromisor,
          { ...advertised, exitCode: 2, stdout: "", stderr: "Could not resolve host" },
        ]),
        cwd,
        ref,
        remoteUrl,
        objectDirectory,
      ),
    ).rejects.toBeInstanceOf(CheckoutFetchError);
  });

  it("classifies a failed pull-ref fetch as a checkout fetch failure", async () => {
    await expect(
      fetchGitHubPullRequestRef(
        scripted([
          shallow,
          notPartial,
          notPromisor,
          advertised,
          initialized,
          basePresent,
          { ...fetched, exitCode: 1, stderr: "network unavailable" },
        ]),
        cwd,
        ref,
        remoteUrl,
        objectDirectory,
      ),
    ).rejects.toMatchObject({
      name: "CheckoutFetchError",
      message: expect.stringContaining("Failed to fetch GitHub pull-request ref"),
    });
  });

  it.each([
    ["Error", new Error("socket hang up")],
    ["non-Error", "socket hang up"],
  ])(
    "classifies a thrown pull-ref transport %s as a checkout fetch failure",
    async (_kind, thrown) => {
      const runner = {
        async run(options: import("./executor.ts").RunProcessOptions) {
          const args = options.argv.slice(1);
          if (args[0] === "rev-parse") {
            options.onChunk({ stream: "stdout", data: "false\n" });
            return { exitCode: 0, timedOut: false, signal: null };
          }
          if (args[0] === "config") return { exitCode: 1, timedOut: false, signal: null };
          if (args[0] === "ls-remote") throw thrown;
          throw new Error(`unexpected git ${args.join(" ")}`);
        },
      };
      await expect(
        fetchGitHubPullRequestRef(runner, cwd, ref, remoteUrl, objectDirectory),
      ).rejects.toBeInstanceOf(CheckoutFetchError);
    },
  );

  it.each([
    ["empty successful advertisement", [{ ...advertised, stdout: "" }]],
    [
      "ambiguous advertisement lines",
      [{ ...advertised, stdout: `${pullSha}\t${ref}\n${pullSha}\t${ref}\n` }],
    ],
    ["malformed advertisement", [{ ...advertised, stdout: "not-a-ref\n" }]],
    ["ambiguous advertisement", [{ ...advertised, stdout: `${pullSha}\t${ref}\tunexpected\n` }]],
    ["initialization", [advertised, { ...initialized, exitCode: 1 }]],
    ["missing local remote HEAD", [advertised, initialized, { ...basePresent, exitCode: 1 }]],
    [
      "resolution",
      [advertised, initialized, basePresent, fetched, { ...resolved, exitCode: 1, stdout: "" }],
    ],
    [
      "mismatched resolutions after the bounded retry",
      [
        advertised,
        initialized,
        basePresent,
        fetched,
        { ...resolved, stdout: "f".repeat(40) },
        advertised,
        initialized,
        basePresent,
        fetched,
        { ...resolved, stdout: "e".repeat(40) },
      ],
    ],
    [
      "bundle creation",
      [
        advertised,
        initialized,
        basePresent,
        fetched,
        resolved,
        commonBase,
        pullNotPresent,
        { ...bundled, exitCode: 1 },
      ],
    ],
    [
      "bundle import",
      [
        advertised,
        initialized,
        basePresent,
        fetched,
        resolved,
        commonBase,
        pullNotPresent,
        bundled,
        { ...imported, exitCode: 1 },
      ],
    ],
    [
      "scratch-ref update",
      [
        advertised,
        initialized,
        basePresent,
        fetched,
        resolved,
        commonBase,
        pullNotPresent,
        bundled,
        imported,
        { match: ["update-ref", "--no-deref", "*", pullSha], exitCode: 1 },
      ],
    ],
  ])("returns null after failed %s", async (_stage, steps) => {
    await expect(
      fetchGitHubPullRequestRef(
        scripted([shallow, notPartial, notPromisor, ...steps]),
        cwd,
        ref,
        remoteUrl,
        objectDirectory,
      ),
    ).resolves.toBeNull();
  });

  it.each([
    ["shallow", [{ ...shallow, stdout: "true\n" }]],
    ["partial clone", [shallow, { ...notPartial, exitCode: 0 }]],
    ["promisor remote", [shallow, notPartial, { ...notPromisor, exitCode: 0 }]],
    [
      "missing remote HEAD",
      [shallow, notPartial, notPromisor, { ...advertised, stdout: `${pullSha}\t${ref}\n` }],
    ],
    [
      "wrong SHA-1 object width",
      [
        shallow,
        notPartial,
        notPromisor,
        {
          ...advertised,
          stdout: `${pullSha}${"0123456789abcdef01234567"}\t${ref}\n${baseSha}\tHEAD\n`,
        },
      ],
    ],
  ])("fails closed before transfer for %s", async (_description, steps) => {
    await expect(
      fetchGitHubPullRequestRef(scripted(steps), cwd, ref, remoteUrl, objectDirectory),
    ).resolves.toBeNull();
  });

  it("uses remote HEAD as the delta prerequisite after proving a diverged pull has a common base", async () => {
    const commonAncestor = "fedcba9876543210fedcba9876543210fedcba98";
    await expect(
      fetchGitHubPullRequestRef(
        scripted([
          shallow,
          notPartial,
          notPromisor,
          advertised,
          initialized,
          basePresent,
          fetched,
          resolved,
          {
            match: ["--git-dir", "*", "merge-base", pullSha, baseSha],
            exitCode: 0,
            stdout: `${commonAncestor}\n`,
          },
          pullNotPresent,
          bundled,
          imported,
          { match: ["update-ref", "--no-deref", "*", pullSha], exitCode: 0 },
        ]),
        cwd,
        ref,
        remoteUrl,
        objectDirectory,
      ),
    ).resolves.toMatchObject({ sha: pullSha });
  });

  it("does not consult the session worktree HEAD when selecting the negotiation tip", async () => {
    const runner = scripted([
      shallow,
      notPartial,
      notPromisor,
      advertised,
      initialized,
      basePresent,
      fetched,
      resolved,
      commonBase,
      pullNotPresent,
      bundled,
      imported,
      { match: ["update-ref", "--no-deref", "*", pullSha], exitCode: 0 },
    ]);
    const originalRun = runner.run.bind(runner);
    runner.run = async (options) => {
      if (options.argv.slice(1).join(" ") === "rev-parse HEAD") {
        throw new Error("session HEAD must not select the transfer base");
      }
      return originalRun(options);
    };

    await expect(
      fetchGitHubPullRequestRef(runner, cwd, ref, remoteUrl, objectDirectory),
    ).resolves.toMatchObject({ sha: pullSha });
  });

  it("fails closed without a common ancestor instead of writing a full bundle", async () => {
    await expect(
      fetchGitHubPullRequestRef(
        scripted([
          shallow,
          notPartial,
          notPromisor,
          advertised,
          initialized,
          basePresent,
          fetched,
          resolved,
          { match: ["--git-dir", "*", "merge-base", pullSha, baseSha], exitCode: 1 },
        ]),
        cwd,
        ref,
        remoteUrl,
        objectDirectory,
      ),
    ).resolves.toBeNull();
  });

  it.each([
    [
      "cannot root an already-present pull head",
      [
        commonBase,
        { ...pullNotPresent, exitCode: 0 },
        { match: ["update-ref", "--no-deref", "*", pullSha], exitCode: 1 },
      ],
    ],
    [
      "cannot determine whether a pull head is already present",
      [commonBase, { ...pullNotPresent, exitCode: 128 }],
    ],
  ])("fails closed when it %s", async (_description, tail) => {
    await expect(
      fetchGitHubPullRequestRef(
        scripted([
          shallow,
          notPartial,
          notPromisor,
          advertised,
          initialized,
          basePresent,
          fetched,
          resolved,
          ...tail,
        ]),
        cwd,
        ref,
        remoteUrl,
        objectDirectory,
      ),
    ).resolves.toBeNull();
  });

  it("runs the advertised-ref transport from the administrator-owned filesystem root", async () => {
    let lsRemoteCwd: string | undefined;
    const runner = {
      async run(options: import("./executor.ts").RunProcessOptions) {
        const args = options.argv.slice(1);
        if (args[0] === "rev-parse") {
          options.onChunk({ stream: "stdout", data: "false\n" });
          return { exitCode: 0, timedOut: false, signal: null };
        }
        if (args[0] === "config") return { exitCode: 1, timedOut: false, signal: null };
        if (args[0] === "ls-remote") {
          lsRemoteCwd = options.cwd;
          options.onChunk({ stream: "stdout", data: `${pullSha}\t${ref}\n${baseSha}\tHEAD\n` });
          return { exitCode: 0, timedOut: false, signal: null };
        }
        if (args[0] === "init") return { exitCode: 1, timedOut: false, signal: null };
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
    };

    await expect(
      fetchGitHubPullRequestRef(runner, cwd, ref, remoteUrl, objectDirectory),
    ).resolves.toBeNull();
    expect(lsRemoteCwd).toBe(parse(tmpdir()).root);
  });

  it("encodes a colon in an alternate object directory as one Git path", async () => {
    let fetchEnvironment: NodeJS.ProcessEnv | undefined;
    const runner = {
      async run(options: import("./executor.ts").RunProcessOptions) {
        const args = options.argv.slice(1);
        if (args[0] === "rev-parse") {
          options.onChunk({ stream: "stdout", data: "false\n" });
          return { exitCode: 0, timedOut: false, signal: null };
        }
        if (args[0] === "config") return { exitCode: 1, timedOut: false, signal: null };
        if (args[0] === "ls-remote") {
          options.onChunk({ stream: "stdout", data: `${pullSha}\t${ref}\n${baseSha}\tHEAD\n` });
          return { exitCode: 0, timedOut: false, signal: null };
        }
        if (args[0] === "init") return { exitCode: 0, timedOut: false, signal: null };
        if (args.includes("cat-file")) return { exitCode: 0, timedOut: false, signal: null };
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
        cwd,
        ref,
        remoteUrl,
        '/srv/repos/team:"project/.git/objects',
      ),
    ).rejects.toBeInstanceOf(CheckoutFetchError);
    expect(fetchEnvironment?.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBe(
      '"/srv/repos/team:\\"project/.git/objects"',
    );
  });

  it("materializes through the policy-owned Git directory, not a session-writable temporary repository", async () => {
    let materializationEnvironment: NodeJS.ProcessEnv | undefined;
    const runner = {
      async run(options: import("./executor.ts").RunProcessOptions) {
        const args = options.argv.slice(1);
        if (args[0] === "--git-dir") {
          expect(args).toEqual([
            "--git-dir",
            "/etc/auto-harness/pull-ref-materializers/sha1.git",
            "rev-parse",
            "--show-object-format=storage",
          ]);
          options.onChunk({ stream: "stdout", data: "sha1\n" });
        } else {
          expect(args).toEqual(["read-tree", "--reset", "-u", "--no-sparse-checkout", pullSha]);
          materializationEnvironment = options.env;
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };

    await expect(
      materializeGitHubPullRequestRef(
        runner,
        "/etc/auto-harness/pull-ref-materializers/sha1.git",
        cwd,
        pullSha,
        "/srv/repository/.git/objects",
        "/srv/repository/.git/worktrees/one/index",
        "sha1",
      ),
    ).resolves.toBe(true);

    expect(materializationEnvironment).toMatchObject({
      GIT_DIR: "/etc/auto-harness/pull-ref-materializers/sha1.git",
      GIT_WORK_TREE: cwd,
      GIT_INDEX_FILE: "/srv/repository/.git/worktrees/one/index",
    });
    expect(materializationEnvironment?.GIT_DIR).not.toContain("auto-harness-pull-checkout-");
  });

  it("fails closed when the selected immutable materializer uses the wrong object format", async () => {
    const runner = {
      async run(options: import("./executor.ts").RunProcessOptions) {
        expect(options.argv.slice(1)).toEqual([
          "--git-dir",
          "/etc/auto-harness/pull-ref-materializers/sha1.git",
          "rev-parse",
          "--show-object-format=storage",
        ]);
        options.onChunk({ stream: "stdout", data: "sha256\n" });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };

    await expect(
      materializeGitHubPullRequestRef(
        runner,
        "/etc/auto-harness/pull-ref-materializers/sha1.git",
        cwd,
        pullSha,
        "/srv/repository/.git/objects",
        "/srv/repository/.git/worktrees/one/index",
        "sha1",
      ),
    ).resolves.toBe(false);
  });

  it("disables repository hooks while deleting the scratch ref", async () => {
    let cleanupEnvironment: NodeJS.ProcessEnv | undefined;
    const runner = {
      async run(options: import("./executor.ts").RunProcessOptions) {
        cleanupEnvironment = options.env;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };

    await deleteGitHubPullRequestRef(runner, cwd, "refs/worktree/auto-harness/pull-fetch/id", ref);
    expect(cleanupEnvironment).toMatchObject({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_VALUE_1: "false",
      GIT_NO_REPLACE_OBJECTS: "1",
    });
  });

  it("disables fsmonitor while importing and creating the scratch ref", async () => {
    let importEnvironment: NodeJS.ProcessEnv | undefined;
    let scratchRefEnvironment: NodeJS.ProcessEnv | undefined;
    const runner = scripted([
      shallow,
      notPartial,
      notPromisor,
      advertised,
      initialized,
      basePresent,
      fetched,
      resolved,
      commonBase,
      pullNotPresent,
      bundled,
      imported,
      { match: ["update-ref", "--no-deref", "*", pullSha], exitCode: 0 },
    ]);
    const originalRun = runner.run.bind(runner);
    runner.run = async (options) => {
      if (options.argv.slice(1).includes("unbundle")) importEnvironment = options.env;
      if (options.argv.slice(1).includes("update-ref")) scratchRefEnvironment = options.env;
      return originalRun(options);
    };

    await expect(
      fetchGitHubPullRequestRef(runner, cwd, ref, remoteUrl, objectDirectory),
    ).resolves.toMatchObject({
      sha: pullSha,
    });
    expect(importEnvironment).toMatchObject({
      GIT_CONFIG_KEY_3: "core.fsmonitor",
      GIT_CONFIG_VALUE_3: "false",
    });
    expect(scratchRefEnvironment).toMatchObject({
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
    });
  });

  it("re-advertises once when the pull head moves during fetch", async () => {
    const movedSha = "fedcba9876543210fedcba9876543210fedcba98";
    const destination = await fetchGitHubPullRequestRef(
      scripted([
        shallow,
        notPartial,
        notPromisor,
        advertised,
        initialized,
        basePresent,
        fetched,
        { ...resolved, stdout: `${movedSha}\n` },
        { ...advertised, stdout: `${movedSha}\t${ref}\n${baseSha}\tHEAD\n` },
        initialized,
        basePresent,
        fetched,
        { ...resolved, stdout: `${movedSha}\n` },
        {
          match: ["--git-dir", "*", "merge-base", movedSha, baseSha],
          exitCode: 0,
          stdout: `${baseSha}\n`,
        },
        {
          match: ["--git-dir", "*", "merge-base", "--is-ancestor", movedSha, baseSha],
          exitCode: 1,
        },
        {
          match: [
            "--git-dir",
            "*",
            "bundle",
            "create",
            "*",
            "refs/auto-harness/pull-fetch/source",
            movedSha,
            `^${baseSha}`,
          ],
          exitCode: 0,
        },
        imported,
        { match: ["update-ref", "--no-deref", "*", movedSha], exitCode: 0 },
      ]),
      cwd,
      ref,
      remoteUrl,
      objectDirectory,
    );

    expect(destination).toMatchObject({ sha: movedSha });
  });

  it("initializes the scratch repository with the checkout object format", async () => {
    await expect(
      fetchGitHubPullRequestRef(
        scripted([
          shallow,
          notPartial,
          notPromisor,
          {
            ...advertised,
            stdout: `${pullSha}${"0123456789abcdef01234567"}\t${ref}\n${baseSha}${"0123456789abcdef01234567"}\tHEAD\n`,
          },
          { ...initialized, match: ["init", "--bare", "--object-format=sha256", "*"], exitCode: 1 },
        ]),
        cwd,
        ref,
        remoteUrl,
        objectDirectory,
        undefined,
        "sha256",
      ),
    ).resolves.toBeNull();
  });

  it("roots an already-present pull head without creating an empty bundle", async () => {
    const destination = await fetchGitHubPullRequestRef(
      scripted([
        shallow,
        notPartial,
        notPromisor,
        advertised,
        initialized,
        basePresent,
        fetched,
        resolved,
        {
          match: ["--git-dir", "*", "merge-base", pullSha, baseSha],
          exitCode: 0,
          stdout: `${baseSha}\n`,
        },
        {
          match: ["--git-dir", "*", "merge-base", "--is-ancestor", pullSha, baseSha],
          exitCode: 0,
        },
        { match: ["update-ref", "--no-deref", "*", pullSha], exitCode: 0 },
      ]),
      cwd,
      ref,
      { remoteUrl, transport: {} },
      objectDirectory,
    );

    expect(destination).toMatchObject({
      ref: expect.stringMatching(/^refs\/worktree\/auto-harness\/pull-fetch\//),
      sha: pullSha,
    });
  });

  it("removes a created scratch ref with a fresh bounded signal when directory cleanup fails", async () => {
    state.failNextTemporaryDirectoryRemoval = true;
    const sessionController = new AbortController();
    let cleanupSignal: AbortSignal | undefined;
    const runner = scripted([
      shallow,
      notPartial,
      notPromisor,
      advertised,
      initialized,
      basePresent,
      fetched,
      resolved,
      commonBase,
      pullNotPresent,
      bundled,
      imported,
      { match: ["update-ref", "--no-deref", "*", pullSha], exitCode: 0 },
      { match: ["update-ref", "--no-deref", "-d", "*"], exitCode: 0 },
    ]);
    const originalRun = runner.run.bind(runner);
    runner.run = async (options) => {
      if (options.argv.slice(1).includes("-d")) cleanupSignal = options.signal;
      const result = await originalRun(options);
      if (options.argv.slice(1).includes("update-ref") && !options.argv.slice(1).includes("-d")) {
        sessionController.abort();
      }
      return result;
    };

    await expect(
      fetchGitHubPullRequestRef(
        runner,
        cwd,
        ref,
        remoteUrl,
        objectDirectory,
        sessionController.signal,
      ),
    ).rejects.toThrow("temporary directory cleanup failed");
    expect(cleanupSignal).toBeDefined();
    expect(cleanupSignal).not.toBe(sessionController.signal);
    expect(cleanupSignal?.aborted).toBe(false);
  });

  it("preserves the directory cleanup error when scratch-ref deletion also fails", async () => {
    state.failNextTemporaryDirectoryRemoval = true;
    const runner = scripted([
      shallow,
      notPartial,
      notPromisor,
      advertised,
      initialized,
      basePresent,
      fetched,
      resolved,
      commonBase,
      pullNotPresent,
      bundled,
      imported,
      { match: ["update-ref", "--no-deref", "*", pullSha], exitCode: 0 },
      { match: ["update-ref", "--no-deref", "-d", "*"], exitCode: 1, stderr: "locked" },
    ]);

    await expect(
      fetchGitHubPullRequestRef(runner, cwd, ref, remoteUrl, objectDirectory),
    ).rejects.toThrow("temporary directory cleanup failed");
  });
});
