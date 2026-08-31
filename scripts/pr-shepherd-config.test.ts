import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const rc = readFileSync(new URL("../.pr-shepherdrc.yml", import.meta.url), "utf8");
const githubDocs = readFileSync(new URL("../docs/github.md", import.meta.url), "utf8");
const classificationDir = join(repoRoot, ".pr-shepherd", "classification");

describe("pr-shepherd CodeRabbit policy", () => {
  it("ignores the CodeRabbit CI check and no other ignoreChecks entries", () => {
    expect(rc).toContain("ignoreChecks:");
    expect([...rc.matchAll(/^\s+- ["']([^"']+)["']\s*$/gm)].map((match) => match[1])).toEqual([
      "CodeRabbit",
    ]);
  });

  it("does not ship a blanket CodeRabbit comment suppressor", () => {
    expect(existsSync(join(repoRoot, ".pr-shepherd", "classification", "coderabbit.mts"))).toBe(
      false,
    );
    if (!existsSync(classificationDir)) return;
    for (const name of readdirSync(classificationDir)) {
      if (!name.endsWith(".mts") && !name.endsWith(".ts") && !name.endsWith(".mjs")) continue;
      const source = readFileSync(join(classificationDir, name), "utf8");
      expect(source, name).not.toMatch(/coderabbit suppressed \(always/i);
      expect(source, name).not.toMatch(/reason: ['"]coderabbit suppressed/i);
    }
  });

  it("documents the check-vs-comment split", () => {
    expect(githubDocs).toContain("ignoreChecks");
    expect(githubDocs).toContain("CodeRabbit");
    expect(githubDocs).toContain("review comments");
    expect(githubDocs).toContain(".pr-shepherdrc.yml");
  });
});
