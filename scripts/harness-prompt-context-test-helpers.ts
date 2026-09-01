import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const actionYml = readFileSync(
  new URL("../actions/harness-prompt-context/action.yml", import.meta.url),
  "utf8",
);

// The real npm-published vouchington-tooling@0.4.1 scripts/gha/write-github-multiline-output.sh,
// exercised in place so the createRequire resolution fix is verified end to end.
const WRITE_MULTILINE_OUTPUT_SH = `#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <output-name>" >&2
  exit 2
fi

output_name=$1
if [[ ! "$output_name" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]; then
  echo "invalid GitHub output name: $output_name" >&2
  exit 2
fi

if [[ -z "\${GITHUB_OUTPUT:-}" ]]; then
  echo 'GITHUB_OUTPUT must be set' >&2
  exit 2
fi

temporary_root=\${RUNNER_TEMP:-\${TMPDIR:-/tmp}}
payload_file=$(mktemp "$temporary_root/write-github-multiline-output.XXXXXX")
trap 'rm -f "$payload_file"' EXIT HUP INT TERM
cat >"$payload_file"

delimiter_prefix=$(printf '%s' "$output_name" | tr '[:lower:]-' '[:upper:]_')
delimiter=''
attempt=1
while [[ $attempt -le 10 ]]; do
  if ! uuid=$(uuidgen); then
    echo 'uuidgen failed while creating a GitHub output delimiter' >&2
    exit 1
  fi
  if [[ -z "$uuid" ]]; then
    echo 'uuidgen returned an empty GitHub output delimiter suffix' >&2
    exit 1
  fi

  normalized_uuid=$(printf '%s' "$uuid" | tr '[:lower:]-' '[:upper:]_')
  delimiter="\${delimiter_prefix}_\${normalized_uuid}"
  if ! grep -Fq -- "$delimiter" "$payload_file"; then
    break
  fi

  delimiter=''
  attempt=$((attempt + 1))
done

if [[ -z "$delimiter" ]]; then
  echo 'could not create a collision-free GitHub output delimiter after 10 attempts' >&2
  exit 1
fi

{
  printf '%s<<%s\\n' "$output_name" "$delimiter"
  cat "$payload_file"
  if [[ -s "$payload_file" ]] && [[ $(tail -c 1 "$payload_file" | wc -l | tr -d ' ') -eq 0 ]]; then
    printf '\\n'
  fi
  printf '%s\\n' "$delimiter"
} >>"$GITHUB_OUTPUT"
`;

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
    runScript,
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
