/* eslint-disable max-lines -- real Git checkout, recovery, and worktree identity cases share one fixture. */
/**
 * Real-git integration: checkoutRef must support a branch that is already
 * checked out in the primary worktree (documented ref: "main").
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { SpawnProcessRunner } from "./executor.ts";
import { createGitClient } from "./git.ts";

async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status !== 0) {
        reject(new Error(`git ${args.join(" ")}: ${stderr || stdout}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function createTwoCommitWorktree(
  root: string,
  objectFormat: "sha1" | "sha256" = "sha1",
): Promise<{
  repo: string;
  targetSha: string;
  worktree: string;
}> {
  const repo = join(root, "repo");
  const worktree = join(root, "wt-1");
  mkdirSync(repo);
  await git(repo, ["init", `--object-format=${objectFormat}`]);
  await git(repo, ["config", "core.autocrlf", "false"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "tracked.txt"), "first\n");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "first"]);
  const firstSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await git(repo, ["worktree", "add", "--detach", worktree, firstSha]);
  writeFileSync(join(repo, "tracked.txt"), "target\n");
  writeFileSync(join(repo, "obstructed.txt"), "target-owned\n");
  await git(repo, ["add", "obstructed.txt"]);
  await git(repo, ["commit", "-am", "target"]);
  const targetSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
  return { repo, targetSha, worktree };
}

async function createPinnedPullHead(
  root: string,
  files: Readonly<Record<string, string>>,
  baseRepository: string,
  objectFormat: "sha1" | "sha256" = "sha1",
): Promise<{ remote: string; sha: string }> {
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  await git(root, ["init", "--bare", `--object-format=${objectFormat}`, remote]);
  await git(baseRepository, ["push", remote, "HEAD:refs/heads/main"]);
  await git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(root, ["clone", remote, source]);
  await git(source, ["config", "user.email", "t@example.com"]);
  await git(source, ["config", "user.name", "t"]);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), contents);
  }
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "trusted pull head"]);
  const sha = (await git(source, ["rev-parse", "HEAD"])).trim();
  await git(source, ["push", remote, "HEAD:refs/pull/42/head"]);
  return { remote, sha };
}

async function createTrustedMaterializer(
  root: string,
  objectFormat: "sha1" | "sha256" = "sha1",
): Promise<string> {
  const materializer = join(root, `pull-ref-materializer-${objectFormat}.git`);
  await git(root, ["init", "--bare", `--object-format=${objectFormat}`, materializer]);
  return materializer;
}

function pullRefPolicy(remoteUrl: string, materializer: string, sha256Materializer = materializer) {
  return {
    materializerGitDirs: { sha1: materializer, sha256: sha256Materializer },
    remoteUrl,
    transport: {},
  };
}

async function indexLockPath(worktree: string): Promise<string> {
  return (
    await git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index.lock"])
  ).trim();
}

function overwriteExistingFile(path: string, contents: string): void {
  chmodSync(path, 0o600);
  const file = openSync(path, "r+");
  try {
    ftruncateSync(file, 0);
    writeFileSync(file, contents);
  } finally {
    closeSync(file);
  }
}

describe("createGitClient real git", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) {
      rmSync(r, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it("checkouts main in a secondary worktree while primary is on main", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-main-"));
    roots.push(root);
    const repo = join(root, "repo");
    const wt = join(root, "wt-1");
    mkdirSync(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "main\n");
    await git(repo, ["add", "f.txt"]);
    await git(repo, ["commit", "-m", "init"]);
    await git(repo, ["branch", "-M", "main"]);
    // primary is on main
    expect((await git(repo, ["branch", "--show-current"])).trim()).toBe("main");
    const mainSha = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const client = createGitClient(new SpawnProcessRunner());
    await client.ensureWorktree({
      repoPath: repo,
      worktreePath: wt,
      branch: "main",
    });
    // This is the documented failure mode before the fix:
    await client.checkoutRef({ cwd: wt, repoPath: repo, ref: "main" });
    const head = await client.revParse(wt, "HEAD");
    expect(head).toBe(mainSha);
  });

  it("fetches a pinned pull head without applying a later local URL rewrite", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-pull-ref-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    const remote = join(root, "remote.git");
    const source = join(root, "source");
    const attackerRemote = join(root, "attacker.git");
    const attacker = join(root, "attacker-source");
    await git(root, ["init", "--bare", remote]);
    await git(root, ["init", "--bare", attackerRemote]);
    await git(repo, ["push", remote, "HEAD:refs/heads/main"]);
    await git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await git(root, ["clone", remote, source]);
    await git(source, ["config", "user.email", "t@example.com"]);
    await git(source, ["config", "user.name", "t"]);
    writeFileSync(join(source, "from.txt"), "trusted\n");
    await git(source, ["add", "from.txt"]);
    await git(source, ["commit", "-m", "trusted pull head"]);
    const trustedSha = (await git(source, ["rev-parse", "HEAD"])).trim();
    await git(source, ["push", remote, "HEAD:refs/pull/42/head"]);
    mkdirSync(attacker);
    await git(attacker, ["init"]);
    await git(attacker, ["config", "user.email", "t@example.com"]);
    await git(attacker, ["config", "user.name", "t"]);
    writeFileSync(join(attacker, "from.txt"), "attacker\n");
    await git(attacker, ["add", "from.txt"]);
    await git(attacker, ["commit", "-m", "attacker pull head"]);
    await git(attacker, ["push", attackerRemote, "HEAD:refs/pull/42/head"]);

    await git(repo, ["remote", "add", "origin", remote]);
    const materializer = await createTrustedMaterializer(root);
    const processRunner = new SpawnProcessRunner();
    let bundleArguments: readonly string[] | undefined;
    const runner = {
      async run(options: import("./executor.ts").RunProcessOptions) {
        if (options.argv.slice(1).includes("create")) bundleArguments = options.argv.slice(1);
        return processRunner.run(options);
      },
    };
    const client = createGitClient(
      runner,
      new Map([[resolvePath(repo), pullRefPolicy(remote, materializer)]]),
    );
    // Models a prior untrusted session mutating the shared local Git config after policy load.
    await git(repo, ["config", `url.${attackerRemote}.insteadOf`, remote]);

    await client.checkoutRef({ cwd: worktree, repoPath: repo, ref: "refs/pull/42/head" });

    await expect(client.revParse(worktree, "HEAD")).resolves.toBe(trustedSha);
    await expect(
      git(worktree, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/worktree/auto-harness/pull-fetch",
      ]),
    ).resolves.toBe("");
    expect(bundleArguments).toContain(`^${targetSha}`);
  });

  it("disables a prior session's fsmonitor before pull-ref checkout commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-pull-fsmonitor-"));
    roots.push(root);
    const { repo, worktree } = await createTwoCommitWorktree(root);
    const { remote, sha } = await createPinnedPullHead(root, { "trusted.txt": "trusted\n" }, repo);
    const materializer = await createTrustedMaterializer(root);

    const fsmonitorLog = join(root, "fsmonitor.log");
    const fsmonitor = join(root, "fsmonitor.sh");
    writeFileSync(
      fsmonitor,
      `#!/bin/sh\nprintf 'invoked\\n' >> '${fsmonitorLog}'\nprintf 'token\\n'\n`,
    );
    chmodSync(fsmonitor, 0o700);
    await git(repo, ["config", "core.fsmonitor", fsmonitor]);
    writeFileSync(fsmonitorLog, "");

    const client = createGitClient(
      new SpawnProcessRunner(),
      new Map([[resolvePath(repo), pullRefPolicy(remote, materializer)]]),
    );

    await client.checkoutRef({ cwd: worktree, repoPath: repo, ref: "refs/pull/42/head" });

    await expect(client.revParse(worktree, "HEAD")).resolves.toBe(sha);
    expect(readFileSync(join(worktree, "trusted.txt"), "utf8")).toBe("trusted\n");
    expect(readFileSync(fsmonitorLog, "utf8")).toBe("");
  });

  it("uses the separate SHA-256 policy materializer for a SHA-256 pull head", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-pull-sha256-"));
    roots.push(root);
    const { repo, worktree } = await createTwoCommitWorktree(root, "sha256");
    const { remote, sha } = await createPinnedPullHead(
      root,
      { "trusted.txt": "trusted SHA-256 pull head\n" },
      repo,
      "sha256",
    );
    const sha1Materializer = await createTrustedMaterializer(root);
    const sha256Materializer = await createTrustedMaterializer(root, "sha256");
    const client = createGitClient(
      new SpawnProcessRunner(),
      new Map([[resolvePath(repo), pullRefPolicy(remote, sha1Materializer, sha256Materializer)]]),
    );

    await client.checkoutRef({ cwd: worktree, repoPath: repo, ref: "refs/pull/42/head" });

    await expect(client.revParse(worktree, "HEAD")).resolves.toBe(sha);
    expect(readFileSync(join(worktree, "trusted.txt"), "utf8")).toBe("trusted SHA-256 pull head\n");
  });

  it("materializes every trusted pull-ref path despite prior sparse settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-pull-sparse-"));
    roots.push(root);
    const { repo, worktree } = await createTwoCommitWorktree(root);
    const { remote, sha } = await createPinnedPullHead(
      root,
      { "included.txt": "included\n", "omitted.txt": "omitted\n" },
      repo,
    );
    const materializer = await createTrustedMaterializer(root);
    const commonDir = (await git(repo, ["rev-parse", "--git-common-dir"])).trim();
    await git(repo, ["config", "core.sparseCheckout", "true"]);
    writeFileSync(join(resolvePath(repo, commonDir), "info", "sparse-checkout"), "/included.txt\n");

    const client = createGitClient(
      new SpawnProcessRunner(),
      new Map([[resolvePath(repo), pullRefPolicy(remote, materializer)]]),
    );
    await client.checkoutRef({ cwd: worktree, repoPath: repo, ref: "refs/pull/42/head" });

    await expect(client.revParse(worktree, "HEAD")).resolves.toBe(sha);
    expect(readFileSync(join(worktree, "included.txt"), "utf8")).toBe("included\n");
    expect(readFileSync(join(worktree, "omitted.txt"), "utf8")).toBe("omitted\n");
    // `read-tree` receives the real linked-worktree index explicitly. Check that its result and
    // the detached HEAD agree, rather than only observing the materialized files.
    await expect(git(worktree, ["show", ":omitted.txt"])).resolves.toBe("omitted\n");
    await expect(git(worktree, ["status", "--porcelain"])).resolves.toBe("");
  });

  it("clears hidden tracked-file index flags before pull-ref materialization", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-pull-index-flags-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    const { remote, sha } = await createPinnedPullHead(
      root,
      { "tracked.txt": "pull-tracked\n", "obstructed.txt": "pull-obstructed\n" },
      repo,
    );
    const materializer = await createTrustedMaterializer(root);
    const client = createGitClient(
      new SpawnProcessRunner(),
      new Map([[resolvePath(repo), pullRefPolicy(remote, materializer)]]),
    );
    await client.checkoutRef({ cwd: worktree, repoPath: repo, ref: targetSha });
    await git(worktree, ["update-index", "--skip-worktree", "tracked.txt"]);
    await git(worktree, ["update-index", "--assume-unchanged", "obstructed.txt"]);
    writeFileSync(join(worktree, "tracked.txt"), "hidden session modification\n");
    writeFileSync(join(worktree, "obstructed.txt"), "assumed session modification\n");
    writeFileSync(join(worktree, "untracked.txt"), "keep me\n");

    await client.checkoutRef({ cwd: worktree, repoPath: repo, ref: "refs/pull/42/head" });

    await expect(client.revParse(worktree, "HEAD")).resolves.toBe(sha);
    expect(readFileSync(join(worktree, "tracked.txt"), "utf8")).toBe("pull-tracked\n");
    expect(readFileSync(join(worktree, "obstructed.txt"), "utf8")).toBe("pull-obstructed\n");
    expect(readFileSync(join(worktree, "untracked.txt"), "utf8")).toBe("keep me\n");
  });

  it("does not read filter settings added after a pull head is fetched", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-pull-filter-race-"));
    roots.push(root);
    const { repo, worktree } = await createTwoCommitWorktree(root);
    const { remote, sha } = await createPinnedPullHead(root, { "race.txt": "trusted\n" }, repo);
    const materializer = await createTrustedMaterializer(root);
    const filterLog = join(root, "filter.log");
    const filter = join(root, "filter.sh");
    writeFileSync(filter, `#!/bin/sh\nprintf 'invoked\\n' >> '${filterLog}'\ncat\n`);
    chmodSync(filter, 0o700);
    writeFileSync(filterLog, "");

    const processRunner = new SpawnProcessRunner();
    let mutated = false;
    const runner = {
      async run(options: import("./executor.ts").RunProcessOptions) {
        const result = await processRunner.run(options);
        if (!mutated && options.argv.slice(1).includes("unbundle")) {
          mutated = true;
          await git(repo, ["config", "filter.attacker.clean", "cat"]);
          await git(repo, ["config", "filter.attacker.smudge", filter]);
          const commonDir = (await git(repo, ["rev-parse", "--git-common-dir"])).trim();
          writeFileSync(
            join(resolvePath(repo, commonDir), "info", "attributes"),
            "race.txt filter=attacker\n",
          );
        }
        return result;
      },
    };
    const client = createGitClient(
      runner,
      new Map([[resolvePath(repo), pullRefPolicy(remote, materializer)]]),
    );

    await client.checkoutRef({ cwd: worktree, repoPath: repo, ref: "refs/pull/42/head" });

    expect(mutated).toBe(true);
    await expect(client.revParse(worktree, "HEAD")).resolves.toBe(sha);
    expect(readFileSync(join(worktree, "race.txt"), "utf8")).toBe("trusted\n");
    await expect(git(worktree, ["show", ":race.txt"])).resolves.toBe("trusted\n");
    expect(readFileSync(filterLog, "utf8")).toBe("");
    await expect(git(worktree, ["status", "--porcelain"])).resolves.toBe("");
  });

  it("rejects a pull head with submodules without initializing its configured URL", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-pull-submodule-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    const remote = join(root, "remote.git");
    const source = join(root, "source");
    await git(root, ["init", "--bare", remote]);
    await git(repo, ["push", remote, "HEAD:refs/heads/main"]);
    await git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await git(root, ["clone", remote, source]);
    await git(source, ["config", "user.email", "t@example.com"]);
    await git(source, ["config", "user.name", "t"]);
    writeFileSync(
      join(source, ".gitmodules"),
      '[submodule "attacker"]\n\tpath = attacker\n\turl = https://attacker.invalid/repository.git\n',
    );
    await git(source, ["add", ".gitmodules"]);
    await git(source, ["update-index", "--add", "--cacheinfo", `160000,${targetSha},attacker`]);
    await git(source, ["commit", "-m", "pull head with submodule"]);
    await git(source, ["push", remote, "HEAD:refs/pull/42/head"]);
    const before = await git(worktree, ["rev-parse", "HEAD"]);
    const materializer = await createTrustedMaterializer(root);
    const client = createGitClient(
      new SpawnProcessRunner(),
      new Map([[resolvePath(repo), pullRefPolicy(remote, materializer)]]),
    );

    await expect(
      client.checkoutRef({ cwd: worktree, repoPath: repo, ref: "refs/pull/42/head" }),
    ).rejects.toThrow("Configured pull-ref checkout contains submodules");

    expect(existsSync(join(worktree, "attacker", ".git"))).toBe(false);
    await expect(client.revParse(worktree, "HEAD")).resolves.not.toBe(before.trim());
  });

  it("fails closed before transfer for a shallow claimed checkout", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-shallow-pull-ref-"));
    roots.push(root);
    const remote = join(root, "remote.git");
    const source = join(root, "source");
    const shallowRepo = join(root, "shallow-repo");
    const shallowWorktree = join(root, "shallow-worktree");
    await git(root, ["init", "--bare", remote]);
    mkdirSync(source);
    await git(source, ["init"]);
    await git(source, ["config", "user.email", "t@example.com"]);
    await git(source, ["config", "user.name", "t"]);
    writeFileSync(join(source, "base.txt"), "base\n");
    await git(source, ["add", "base.txt"]);
    await git(source, ["commit", "-m", "base"]);
    const baseSha = (await git(source, ["rev-parse", "HEAD"])).trim();
    await git(source, ["branch", "-M", "main"]);
    writeFileSync(join(source, "main.txt"), "main\n");
    await git(source, ["add", "main.txt"]);
    await git(source, ["commit", "-m", "main"]);
    await git(source, ["push", remote, "main"]);
    await git(source, ["switch", "--detach", baseSha]);
    writeFileSync(join(source, "pull.txt"), "pull\n");
    await git(source, ["add", "pull.txt"]);
    await git(source, ["commit", "-m", "pull head"]);
    const pullSha = (await git(source, ["rev-parse", "HEAD"])).trim();
    await git(source, ["push", remote, "HEAD:refs/pull/42/head"]);

    await git(root, ["clone", "--depth", "1", "--branch", "main", `file://${remote}`, shallowRepo]);
    await git(shallowRepo, ["worktree", "add", "--detach", shallowWorktree, "HEAD"]);
    await expect(git(shallowWorktree, ["rev-parse", "--is-shallow-repository"])).resolves.toBe(
      "true\n",
    );
    const materializer = await createTrustedMaterializer(root);

    const client = createGitClient(
      new SpawnProcessRunner(),
      new Map([[resolvePath(shallowRepo), pullRefPolicy(`file://${remote}`, materializer)]]),
    );
    await expect(
      client.checkoutRef({
        cwd: shallowWorktree,
        repoPath: shallowRepo,
        ref: "refs/pull/42/head",
      }),
    ).rejects.toThrow("Failed to fetch GitHub pull-request ref");
    await expect(client.revParse(shallowWorktree, "HEAD")).resolves.not.toBe(pullSha);
  });

  it("recycles tracked state while preserving unrelated untracked files", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-recycle-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    writeFileSync(join(worktree, "tracked.txt"), "session modification\n");
    writeFileSync(join(worktree, "obstructed.txt"), "untracked obstruction\n");
    writeFileSync(join(worktree, "untracked.txt"), "keep me\n");

    const client = createGitClient(new SpawnProcessRunner());
    await client.checkoutRef({ cwd: worktree, repoPath: repo, ref: targetSha });

    await expect(client.revParse(worktree, "HEAD")).resolves.toBe(targetSha);
    expect(readFileSync(join(worktree, "tracked.txt"), "utf8")).toBe("target\n");
    expect(readFileSync(join(worktree, "obstructed.txt"), "utf8")).toBe("target-owned\n");
    expect(readFileSync(join(worktree, "untracked.txt"), "utf8")).toBe("keep me\n");
  });

  it("clears hidden tracked-file index flags before recycling", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-index-flags-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    const client = createGitClient(new SpawnProcessRunner());
    await client.checkoutRef({ cwd: worktree, repoPath: repo, ref: targetSha });
    await git(worktree, ["update-index", "--skip-worktree", "tracked.txt"]);
    await git(worktree, ["update-index", "--assume-unchanged", "obstructed.txt"]);
    writeFileSync(join(worktree, "tracked.txt"), "hidden session modification\n");
    writeFileSync(join(worktree, "obstructed.txt"), "assumed session modification\n");

    await client.checkoutRef({ cwd: worktree, repoPath: repo, ref: targetSha });

    expect(readFileSync(join(worktree, "tracked.txt"), "utf8")).toBe("target\n");
    expect(readFileSync(join(worktree, "obstructed.txt"), "utf8")).toBe("target-owned\n");
  });

  it("aborts an interrupted cherry-pick before recycling", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-cherry-pick-"));
    roots.push(root);
    const repo = join(root, "repo");
    const worktree = join(root, "wt");
    mkdirSync(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "core.autocrlf", "false"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "base\n");
    await git(repo, ["add", "f.txt"]);
    await git(repo, ["commit", "-m", "base"]);
    const baseSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await git(repo, ["switch", "-c", "feature"]);
    writeFileSync(join(repo, "f.txt"), "feature\n");
    await git(repo, ["commit", "-am", "feature"]);
    const featureSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await git(repo, ["switch", "-c", "main", baseSha]);
    writeFileSync(join(repo, "f.txt"), "main\n");
    await git(repo, ["commit", "-am", "main"]);
    const mainSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await git(repo, ["worktree", "add", "--detach", worktree, mainSha]);
    await expect(git(worktree, ["cherry-pick", featureSha])).rejects.toThrow();
    const cherryPickHead = (
      await git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "CHERRY_PICK_HEAD"])
    ).trim();
    expect(existsSync(cherryPickHead)).toBe(true);

    await createGitClient(new SpawnProcessRunner()).checkoutRef({
      cwd: worktree,
      repoPath: repo,
      ref: mainSha,
    });

    expect(existsSync(cherryPickHead)).toBe(false);
    expect(readFileSync(join(worktree, "f.txt"), "utf8")).toBe("main\n");
  });

  it("recycles tracked changes in initialized submodules", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-submodule-"));
    roots.push(root);
    const submodule = join(root, "submodule");
    const repo = join(root, "repo");
    const worktree = join(root, "wt");
    mkdirSync(submodule);
    await git(submodule, ["init"]);
    await git(submodule, ["config", "core.autocrlf", "false"]);
    await git(submodule, ["config", "user.email", "t@example.com"]);
    await git(submodule, ["config", "user.name", "t"]);
    writeFileSync(join(submodule, "tracked.txt"), "recorded\n");
    await git(submodule, ["add", "tracked.txt"]);
    await git(submodule, ["commit", "-m", "initial"]);

    mkdirSync(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "core.autocrlf", "false"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "t"]);
    await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", submodule, "sub"]);
    await git(repo, ["commit", "-am", "add submodule"]);
    const targetSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await git(repo, ["worktree", "add", "--detach", worktree, targetSha]);
    await git(worktree, ["-c", "protocol.file.allow=always", "submodule", "update", "--init"]);
    await git(join(worktree, "sub"), ["config", "core.autocrlf", "false"]);
    writeFileSync(join(worktree, "sub", "tracked.txt"), "session modification\n");

    await createGitClient(new SpawnProcessRunner()).checkoutRef({
      cwd: worktree,
      repoPath: repo,
      ref: targetSha,
    });

    expect(readFileSync(join(worktree, "sub", "tracked.txt"), "utf8")).toBe("recorded\n");
  });

  it("rejects a linked-worktree pointer whose backlink belongs to another worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-identity-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    const victim = join(root, "victim");
    await git(repo, ["worktree", "add", "--detach", victim, targetSha]);
    const victimLock = await indexLockPath(victim);
    writeFileSync(victimLock, "");
    const old = new Date(Date.now() - 60 * 60 * 1_000);
    utimesSync(victimLock, old, old);
    overwriteExistingFile(join(worktree, ".git"), readFileSync(join(victim, ".git"), "utf8"));

    await expect(
      createGitClient(new SpawnProcessRunner()).checkoutRef({
        cwd: worktree,
        repoPath: repo,
        ref: targetSha,
      }),
    ).rejects.toThrow("Configured checkout is not the claimed linked worktree");
    expect(existsSync(victimLock)).toBe(true);
  });

  it("rejects a self-consistent linked-worktree pointer from another repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-foreign-identity-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    const foreignRoot = join(root, "foreign");
    mkdirSync(foreignRoot);
    const { worktree: foreignWorktree } = await createTwoCommitWorktree(foreignRoot);
    const foreignLock = await indexLockPath(foreignWorktree);
    const foreignGitDir = dirname(foreignLock);
    writeFileSync(foreignLock, "");
    const old = new Date(Date.now() - 60 * 60 * 1_000);
    utimesSync(foreignLock, old, old);
    overwriteExistingFile(join(worktree, ".git"), `gitdir: ${foreignGitDir}\n`);
    writeFileSync(join(foreignGitDir, "gitdir"), `${join(worktree, ".git")}\n`);

    await expect(
      createGitClient(new SpawnProcessRunner()).checkoutRef({
        cwd: worktree,
        repoPath: repo,
        ref: targetSha,
      }),
    ).rejects.toThrow("Configured checkout is not the claimed linked worktree");
    expect(existsSync(foreignLock)).toBe(true);
  });

  it("removes an old empty index lock and retries checkout", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-stale-lock-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    const lockPath = await indexLockPath(worktree);
    writeFileSync(lockPath, "");
    const old = new Date(Date.now() - 60 * 60 * 1_000);
    utimesSync(lockPath, old, old);

    const client = createGitClient(new SpawnProcessRunner());
    await client.checkoutRef({ cwd: worktree, repoPath: repo, ref: targetSha });

    expect(existsSync(lockPath)).toBe(false);
    await expect(client.revParse(worktree, "HEAD")).resolves.toBe(targetSha);
  });

  it("preserves a fresh empty index lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-fresh-lock-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    const lockPath = await indexLockPath(worktree);
    writeFileSync(lockPath, "");

    const checkout = createGitClient(new SpawnProcessRunner()).checkoutRef({
      cwd: worktree,
      repoPath: repo,
      ref: targetSha,
    });

    await expect(checkout).rejects.toThrow(/Failed to checkout resolved ref.*index\.lock/);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("preserves a non-empty old index lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-nonempty-lock-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    const lockPath = await indexLockPath(worktree);
    writeFileSync(lockPath, "owner");
    const old = new Date(Date.now() - 60 * 60 * 1_000);
    utimesSync(lockPath, old, old);

    const checkout = createGitClient(new SpawnProcessRunner()).checkoutRef({
      cwd: worktree,
      repoPath: repo,
      ref: targetSha,
    });

    await expect(checkout).rejects.toThrow(/Failed to checkout resolved ref.*index\.lock/);
    expect(readFileSync(lockPath, "utf8")).toBe("owner");
  });

  it("preserves an old index lock symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-symlink-lock-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    const lockPath = await indexLockPath(worktree);
    const target = join(root, "lock-target");
    writeFileSync(target, "");
    const old = new Date(Date.now() - 60 * 60 * 1_000);
    utimesSync(target, old, old);
    symlinkSync(target, lockPath);

    const checkout = createGitClient(new SpawnProcessRunner()).checkoutRef({
      cwd: worktree,
      repoPath: repo,
      ref: targetSha,
    });

    await expect(checkout).rejects.toThrow(/Failed to checkout resolved ref.*index\.lock/);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("peels an annotated tag before detaching at its commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-tag-"));
    roots.push(root);
    const repo = join(root, "repo");
    mkdirSync(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "main\n");
    await git(repo, ["add", "f.txt"]);
    await git(repo, ["commit", "-m", "init"]);
    await git(repo, ["tag", "-a", "v1.2.3", "-m", "release"]);
    const tagCommit = (await git(repo, ["rev-parse", "v1.2.3^{commit}"])).trim();
    const worktree = join(root, "wt");
    await git(repo, ["worktree", "add", "--detach", worktree, tagCommit]);

    const client = createGitClient(new SpawnProcessRunner());
    await client.checkoutRef({ cwd: worktree, repoPath: repo, ref: "v1.2.3" });

    await expect(client.revParse(worktree, "HEAD")).resolves.toBe(tagCommit);
  });

  it("fetches missing tree objects after an exact-SHA checkout fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-missing-tree-"));
    roots.push(root);
    const source = join(root, "source");
    const remote = join(root, "remote.git");
    const clientPath = join(root, "client");
    const commitFile = join(root, "target-commit");
    mkdirSync(source);
    await git(source, ["init"]);
    await git(source, ["config", "user.email", "t@example.com"]);
    await git(source, ["config", "user.name", "t"]);
    writeFileSync(join(source, "f.txt"), "target\n");
    await git(source, ["add", "f.txt"]);
    await git(source, ["commit", "-m", "target"]);
    await git(source, ["branch", "-M", "main"]);
    const targetSha = (await git(source, ["rev-parse", "HEAD"])).trim();
    await git(root, ["clone", "--bare", source, remote]);
    await git(root, ["clone", "--no-checkout", remote, clientPath]);
    const worktree = join(root, "client-wt");
    await git(clientPath, ["worktree", "add", "--detach", worktree, targetSha]);

    const targetCommit = await git(clientPath, ["cat-file", "commit", targetSha]);
    rmSync(join(clientPath, ".git", "objects"), { recursive: true, force: true });
    mkdirSync(join(clientPath, ".git", "objects"));
    writeFileSync(join(worktree, "f.txt"), "dirty\n");
    writeFileSync(commitFile, targetCommit);
    expect((await git(clientPath, ["hash-object", "-t", "commit", "-w", commitFile])).trim()).toBe(
      targetSha,
    );
    await expect(git(clientPath, ["cat-file", "-e", `${targetSha}^{tree}`])).rejects.toThrow();

    const client = createGitClient(new SpawnProcessRunner());
    await client.checkoutRef({ cwd: worktree, repoPath: clientPath, ref: targetSha });
    await expect(client.revParse(worktree, "HEAD")).resolves.toBe(targetSha);
  });

  it("recognizes an absolute worktree when the repository path is a symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-link-"));
    const externalRoot = mkdtempSync(join(tmpdir(), "ah-git-external-"));
    roots.push(root, externalRoot);
    const repo = join(root, "nested", "repo");
    const linkedRepo = join(root, "repo-link");
    const wt = join(externalRoot, "wt-1");
    mkdirSync(repo, { recursive: true });
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "main\n");
    await git(repo, ["add", "f.txt"]);
    await git(repo, ["commit", "-m", "init"]);
    await git(repo, ["branch", "-M", "main"]);
    symlinkSync(repo, linkedRepo, process.platform === "win32" ? "junction" : "dir");

    const client = createGitClient(new SpawnProcessRunner());
    await client.ensureWorktree({ repoPath: repo, worktreePath: wt, branch: "main" });
    await expect(
      client.ensureWorktree({ repoPath: linkedRepo, worktreePath: wt, branch: "main" }),
    ).resolves.toBeUndefined();
  });
});
