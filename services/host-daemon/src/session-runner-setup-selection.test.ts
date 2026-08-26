import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import type { GitClient } from "./git.ts";
import { SessionRunner } from "./session-runner.ts";
import { baseAssign } from "./session-runner-test-helpers.ts";
import { WorktreeManager } from "./worktree-manager.ts";

const PROJECT_MARKERS = [
  { language: "Node", files: ["package.json", "pnpm-lock.yaml"] },
  { language: "Rust", files: ["Cargo.toml", "Cargo.lock"] },
  { language: "Python", files: ["pyproject.toml", "requirements.txt"] },
  { language: "Go", files: ["go.mod", "go.sum"] },
] as const;

const noopGit: GitClient = {
  ensureRepo: async () => undefined,
  ensureWorktree: async () => undefined,
  checkoutRef: async () => undefined,
  prepareMainCheckout: async () => undefined,
  revParse: async () => "deadbeef",
};

function projectDir(prefix: string, files: readonly string[]): string {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  for (const file of files) writeFileSync(join(cwd, file), "\n");
  return cwd;
}

function runnerFor(worktreePath: string, setupScript?: string): WorktreeManager {
  const config = parseDaemonConfig({
    hostId: "a1",
    repositories: [
      {
        id: "repo-1",
        path: worktreePath,
        defaultBranch: "main",
        worktrees: [{ id: "wt-1", name: "wt-1", path: worktreePath, labels: [] }],
        ...(setupScript === undefined ? {} : { setupScript }),
      },
    ],
  });
  return new WorktreeManager(config, noopGit);
}

describe("SessionRunner setup selection", () => {
  it.each(PROJECT_MARKERS)(
    "does not infer setup from $language project markers",
    async ({ language, files }) => {
      const cwd = projectDir(`auto-harness-no-inferred-${language.toLowerCase()}-`, files);
      const calls: string[][] = [];
      const runner: ProcessRunner = {
        async run(options) {
          calls.push(options.argv);
          return { exitCode: 0, timedOut: false, signal: null };
        },
      };

      const result = await new SessionRunner({
        worktrees: runnerFor(cwd),
        processRunner: runner,
      }).run(baseAssign());

      expect(result.status).toBe("completed");
      expect(calls).toEqual([["echo", "hello"]]);
      expect(result.logs.map((chunk) => chunk.content)).not.toContain("Running setup script...");
    },
  );

  it.each(PROJECT_MARKERS)(
    "runs only an explicit admin setup for $language before the assigned command",
    async ({ language, files }) => {
      const cwd = projectDir(`auto-harness-explicit-setup-${language.toLowerCase()}-`, files);
      const calls: string[][] = [];
      const runner: ProcessRunner = {
        async run(options) {
          calls.push(options.argv);
          if (options.argv[1] === "-c") {
            return {
              exitCode: 0,
              timedOut: false,
              signal: null,
              environment: options.env ?? {},
            };
          }
          return { exitCode: 0, timedOut: false, signal: null };
        },
      };

      const result = await new SessionRunner({
        worktrees: runnerFor(cwd, "admin-configured-setup"),
        processRunner: runner,
      }).run(baseAssign());

      expect(result.status).toBe("completed");
      expect(calls).toHaveLength(2);
      expect(calls[0]?.[1]).toBe("-c");
      expect(calls[0]?.[2]).toContain("admin-configured-setup");
      expect(calls[1]).toEqual(["echo", "hello"]);
      expect(calls.some((argv) => argv[0] === "pnpm")).toBe(false);
    },
  );
});
