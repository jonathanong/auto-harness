import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { WRITE_MULTILINE_OUTPUT_SH } from "./harness-prompt-context-write-multiline-output-fixture.ts";

const actionYml = readFileSync(
  new URL("../actions/harness-prompt-context/action.yml", import.meta.url),
  "utf8",
);

function extractRunBody(): string {
  const marker = "run: |\n";
  const start = actionYml.indexOf(marker);
  if (start === -1) throw new Error("harness-prompt-context/action.yml: missing run: | block");
  const body = actionYml.slice(start + marker.length);
  return body
    .split("\n")
    .map((line) => (line.startsWith("        ") ? line.slice(8) : line))
    .join("\n");
}

export interface Fixture {
  bin: string;
  callLog: string;
  githubOutput: string;
  githubStepSummary: string;
  githubWorkspace: string;
  root: string;
  runScript: string;
}

export function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "harness-prompt-context-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });

  const workspace = join(root, "workspace");
  const toolingDir = join(workspace, "node_modules/vouchington-tooling");
  mkdirSync(join(toolingDir, "scripts/gha"), { recursive: true });
  writeFileSync(join(workspace, "package.json"), "{}\n");
  writeFileSync(
    join(toolingDir, "package.json"),
    JSON.stringify({
      name: "vouchington-tooling",
      version: "0.4.1",
      exports: { ".": "./index.js", "./package.json": "./package.json" },
    }),
  );
  const writerPath = join(toolingDir, "scripts/gha/write-github-multiline-output.sh");
  writeFileSync(writerPath, WRITE_MULTILINE_OUTPUT_SH);
  chmodSync(writerPath, 0o755);

  const runScript = join(root, "run.sh");
  writeFileSync(runScript, extractRunBody());

  const callLog = join(root, "gh-calls.log");
  writeFileSync(callLog, "");

  return {
    bin,
    callLog,
    githubOutput: join(root, "github-output"),
    githubStepSummary: join(root, "github-step-summary"),
    githubWorkspace: workspace,
    root,
    runScript,
  };
}

// Registers an afterEach cleanup for the calling test file's suite and returns a `make()`
// that tracks each fixture it creates, so every test file doesn't need to repeat that
// bookkeeping itself.
export function useFixtures(): { make: () => Fixture } {
  const fixtures: Fixture[] = [];
  afterEach(() => {
    for (const fx of fixtures.splice(0)) {
      rmSync(fx.root, { force: true, recursive: true });
    }
  });
  return {
    make(): Fixture {
      const fx = fixture();
      fixtures.push(fx);
      return fx;
    },
  };
}

export function stubGh(bin: string, callLog: string, body: string): void {
  const path = join(bin, "gh");
  writeFileSync(
    path,
    `#!/usr/bin/env bash\nset -euo pipefail\nprintf 'gh %s\\n' "$*" >> "${callLog}"\n${body}\n`,
  );
  chmodSync(path, 0o755);
}

export function run(fx: Fixture, env: Record<string, string>) {
  writeFileSync(fx.githubOutput, "");
  writeFileSync(fx.githubStepSummary, "");
  return spawnSync("bash", [fx.runScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: fx.githubOutput,
      GITHUB_REPOSITORY: "example/repo",
      GITHUB_STEP_SUMMARY: fx.githubStepSummary,
      GITHUB_WORKSPACE: fx.githubWorkspace,
      PATH: `${fx.bin}:${process.env.PATH ?? ""}`,
      GH_TOKEN: "gh-token-fixture",
      CHECK_ISSUES: "true",
      CHECK_PRS: "true",
      RELATED_EXTRA_LABELS: "automation",
      RELATED_LIMIT: "5",
      RELATED_TITLE_KEY: "",
      SEARCH_MODE: "related-candidates",
      TOPIC_KEY: "",
      ...env,
    },
  });
}

export function readGithubOutput(path: string): Record<string, string> {
  const lines = readFileSync(path, "utf8").split("\n");
  const values: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    const heredoc = /^([a-zA-Z_][a-zA-Z0-9_-]*)<<(.+)$/.exec(line);
    if (heredoc) {
      const key = heredoc[1];
      const delimiter = heredoc[2];
      if (key === undefined || delimiter === undefined) {
        i++;
        continue;
      }
      const collected: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delimiter) {
        collected.push(lines[i] ?? "");
        i++;
      }
      values[key] = collected.join("\n");
      i++;
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) values[line.slice(0, eq)] = line.slice(eq + 1);
    i++;
  }
  return values;
}
