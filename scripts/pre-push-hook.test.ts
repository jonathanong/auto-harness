import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const hookPath = new URL("../.husky/pre-push", import.meta.url).pathname;
const hook = readFileSync(hookPath, "utf8");
const rootPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
const githubActionsGuard = '[ "${GITHUB_ACTIONS:-}" = "true" ] && exit 0\n';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function executable(bin: string, name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function fixture(): { bin: string; directory: string; log: string } {
  const directory = mkdtempSync(join(tmpdir(), "auto-harness-pre-push-test-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  const log = join(directory, "calls.log");
  mkdirSync(bin);
  writeFileSync(log, "");
  return { bin, directory, log };
}

function fakeGit(bin: string, overrides: Record<string, string> = {}): void {
  executable(
    bin,
    "git",
    `case "$*" in
  "rev-parse --abbrev-ref HEAD") echo "${overrides.branch ?? "feature"}" ;;
  "fetch origin main --quiet") exit ${overrides.fetchExit ?? "0"} ;;
  "rev-parse --verify --quiet refs/remotes/origin/main") ${
    overrides.originMainResolves === "0" ? "exit 1" : "echo deadbeef"
  } ;;
  "merge-base --is-ancestor origin/main HEAD") exit ${overrides.ancestorExit ?? "0"} ;;
  *) echo "unexpected git call: $*" >&2; exit 1 ;;
esac`,
  );
}

function fakePnpm(bin: string, log: string, overrides: Record<string, string> = {}): void {
  executable(
    bin,
    "pnpm",
    `printf 'pnpm %s\\n' "$*" >> "${log}"
case "$*" in
  "run --silent fmt:check") exit ${overrides.fmtExit ?? "0"} ;;
  "run --silent lint") exit ${overrides.lintExit ?? "0"} ;;
  *) echo "unexpected pnpm call: $*" >&2; exit 1 ;;
esac`,
  );
}

function run(bin: string, env: Record<string, string | undefined> = {}) {
  return spawnSync("sh", [hookPath], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, ...env },
  });
}

describe("pre-push hook", () => {
  it("guards on GITHUB_ACTIONS before set -e, verbatim", () => {
    expect(hook.slice(0, `#!/bin/sh\n${githubActionsGuard}`.length)).toBe(
      `#!/bin/sh\n${githubActionsGuard}`,
    );
    expect(hook).toContain("set -e");
  });

  it("is executable and valid POSIX sh", () => {
    expect(statSync(hookPath).mode & 0o111).not.toBe(0);
    expect(spawnSync("sh", ["-n", hookPath]).status).toBe(0);
  });

  it("reuses the root fmt:check and lint scripts instead of re-spelling tool flags", () => {
    expect(rootPackage.scripts["fmt:check"]).toBe("oxfmt --check .");
    expect(rootPackage.scripts.lint).toBe("oxlint --deny-warnings .");
    expect(hook).toContain("pnpm run --silent fmt:check");
    expect(hook).toContain("pnpm run --silent lint");
  });

  it("exits 0 under GITHUB_ACTIONS=true without invoking git or pnpm", () => {
    const { bin, log } = fixture();
    fakeGit(bin);
    fakePnpm(bin, log);

    const result = run(bin, { GITHUB_ACTIONS: "true" });

    expect(result.status).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("");
  });

  it("fails loudly when pnpm is not on PATH", () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-harness-pre-push-test-"));
    temporaryDirectories.push(directory);
    const result = spawnSync("sh", [hookPath], {
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pnpm not found on PATH");
  });

  it("fails and prints the exact fix command when formatting is wrong", () => {
    const { bin, log } = fixture();
    fakeGit(bin);
    fakePnpm(bin, log, { fmtExit: "1" });

    const result = run(bin);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pnpm exec oxfmt .");
    expect(readFileSync(log, "utf8")).toBe("pnpm run --silent fmt:check\n");
  });

  it("fails when lint fails, after formatting already passed", () => {
    const { bin, log } = fixture();
    fakeGit(bin);
    fakePnpm(bin, log, { lintExit: "1" });

    const result = run(bin);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("lint failed");
    expect(readFileSync(log, "utf8")).toBe("pnpm run --silent fmt:check\npnpm run --silent lint\n");
  });

  it("skips the up-to-date check when pushing main itself", () => {
    const { bin, log } = fixture();
    fakeGit(bin, { branch: "main" });
    fakePnpm(bin, log);

    const result = run(bin);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pushing main itself");
  });

  it("does not block the push when origin is unreachable", () => {
    const { bin, log } = fixture();
    fakeGit(bin, { fetchExit: "1" });
    fakePnpm(bin, log);

    const result = run(bin);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("could not reach origin (offline?) — not blocking the push");
  });

  it("does not block the push when origin/main cannot be resolved locally", () => {
    const { bin, log } = fixture();
    fakeGit(bin, { originMainResolves: "0" });
    fakePnpm(bin, log);

    const result = run(bin);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("origin/main is not available locally — not blocking");
  });

  it("fails and prints the exact rebase command when behind origin/main", () => {
    const { bin, log } = fixture();
    fakeGit(bin, { ancestorExit: "1" });
    fakePnpm(bin, log);

    const result = run(bin);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("git fetch origin && git rebase origin/main");
  });

  it("checks up-to-date-ness last, only after formatting and lint pass", () => {
    expect(hook.indexOf("fmt:check")).toBeLessThan(hook.indexOf("run --silent lint"));
    expect(hook.indexOf("run --silent lint")).toBeLessThan(hook.indexOf("origin/main"));
  });

  it("never suggests bypassing itself", () => {
    expect(hook).not.toContain("--no-verify");
    expect(hook).not.toContain("HUSKY=0");
  });
});
