import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = new URL(
  "../actions/harness-render-prompt/render-harness-prompt.mts",
  import.meta.url,
).pathname;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function repo(): string {
  const directory = mkdtempSync(join(tmpdir(), "harness-render-prompt-test-"));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, "docs/prompts/automation"), { recursive: true });
  return directory;
}

function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
}

describe("render-harness-prompt.mts", () => {
  it("substitutes --var placeholders and wraps the result in the CI preamble/postlude", () => {
    const cwd = repo();
    writeFileSync(
      join(cwd, "docs/prompts/automation/fix.md"),
      "Fix PR #{{PR_NUMBER}} on {{REPO}}.",
    );

    const result = run(cwd, [
      "--template",
      "docs/prompts/automation/fix.md",
      "--var",
      "PR_NUMBER=42",
      "--var",
      "REPO=example/repo",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("## Auto Harness session");
    expect(result.stdout).toContain("Fix PR #42 on example/repo.");
    expect(result.stdout).toContain("## CI merge authority");
    expect(result.stdout).toContain("Never run `gh pr merge` in any form");
    expect(result.stdout).not.toContain("merge-authority.md");
    expect(result.stdout).toContain("any repository-specific worktree-reset script");
    expect(result.stdout).not.toContain("reset-worktree");
  });

  it("prefers a later --var-file over an earlier --var for the same NAME", () => {
    const cwd = repo();
    writeFileSync(join(cwd, "docs/prompts/automation/fix.md"), "{{LOG}}");
    const logPath = join(cwd, "failure.log");
    writeFileSync(logPath, "line one\nline two\n");

    const result = run(cwd, [
      "--template",
      "docs/prompts/automation/fix.md",
      "--var",
      "LOG=inline",
      "--var-file",
      `LOG=${logPath}`,
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("line one\nline two");
    expect(result.stdout).not.toContain("inline");
  });

  it("writes to --output instead of stdout when given", () => {
    const cwd = repo();
    writeFileSync(join(cwd, "docs/prompts/automation/fix.md"), "hello {{NAME}}");
    const outputPath = join(cwd, "rendered.md");

    const result = run(cwd, [
      "--template",
      "docs/prompts/automation/fix.md",
      "--var",
      "NAME=world",
      "--output",
      outputPath,
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(readFileSync(outputPath, "utf8")).toContain("hello world");
  });

  it("fails on an unresolved placeholder", () => {
    const cwd = repo();
    writeFileSync(join(cwd, "docs/prompts/automation/fix.md"), "{{MISSING}}");

    const result = run(cwd, ["--template", "docs/prompts/automation/fix.md"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unresolved placeholder(s): MISSING");
  });

  it("rejects a template path outside docs/prompts/automation/", () => {
    const cwd = repo();
    mkdirSync(join(cwd, "docs/other"), { recursive: true });
    writeFileSync(join(cwd, "docs/other/fix.md"), "no placeholders");

    const result = run(cwd, ["--template", "docs/other/fix.md"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Template must be a markdown file under docs/prompts/automation/.",
    );
  });

  it("rejects a non-markdown template extension", () => {
    const cwd = repo();
    writeFileSync(join(cwd, "docs/prompts/automation/fix.txt"), "no placeholders");

    const result = run(cwd, ["--template", "docs/prompts/automation/fix.txt"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Template must be a markdown file under docs/prompts/automation/.",
    );
  });

  it("resolves the template under a custom --template-dir", () => {
    const cwd = repo();
    mkdirSync(join(cwd, "prompts"), { recursive: true });
    writeFileSync(join(cwd, "prompts/fix.md"), "no placeholders");

    const result = run(cwd, ["--template", "prompts/fix.md", "--template-dir", "prompts"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no placeholders");
  });

  it("rejects a template outside a custom --template-dir", () => {
    const cwd = repo();
    mkdirSync(join(cwd, "prompts"), { recursive: true });
    writeFileSync(join(cwd, "docs/prompts/automation/fix.md"), "no placeholders");

    const result = run(cwd, [
      "--template",
      "docs/prompts/automation/fix.md",
      "--template-dir",
      "prompts",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Template must be a markdown file under prompts/.");
  });

  it("points the CI merge authority postlude at --merge-authority-doc when given", () => {
    const cwd = repo();
    writeFileSync(join(cwd, "docs/prompts/automation/fix.md"), "no placeholders");

    const result = run(cwd, [
      "--template",
      "docs/prompts/automation/fix.md",
      "--merge-authority-doc",
      "docs/merge-authority.md",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("See `docs/merge-authority.md`.");
  });
});
