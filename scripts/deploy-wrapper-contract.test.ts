import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const awsScript = new URL("deploy-aws.sh", import.meta.url).pathname;
const aws = readFileSync(awsScript, "utf8");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function position(source: string, fragment: string): number {
  const index = source.indexOf(fragment);
  expect(index, `missing script contract: ${fragment}`).toBeGreaterThanOrEqual(0);
  return index;
}

function fakeEnvironment(): { bin: string; directory: string; log: string } {
  const directory = mkdtempSync(join(tmpdir(), "auto-harness-deploy-test-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  const log = join(directory, "calls.log");
  writeFileSync(log, "");
  mkdirSync(bin);
  return { bin, directory, log };
}

function executable(bin: string, name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}

function baseFakes(bin: string): void {
  executable(
    bin,
    "git",
    `
case "$*" in
  "branch --show-current") echo main ;;
  "status --porcelain") ;;
  "rev-parse HEAD"|"rev-parse origin/main") echo same-sha ;;
  "fetch origin main"|"merge --ff-only origin/main") ;;
  *) echo "unexpected git call: $*" >&2; exit 1 ;;
esac`,
  );
  executable(bin, "sleep", 'printf "sleep %s\\n" "$*" >> "$FAKE_LOG"');
}

function run(
  script: string,
  args: string[],
  fixture: ReturnType<typeof fakeEnvironment>,
  environment: NodeJS.ProcessEnv = {},
) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_DIRECTORY: fixture.directory,
      FAKE_LOG: fixture.log,
      HOME: fixture.directory,
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      ...environment,
    },
  });
}

function awsDeploymentFakes(fixture: ReturnType<typeof fakeEnvironment>): void {
  baseFakes(fixture.bin);
  executable(
    fixture.bin,
    "pnpm",
    `
printf "pnpm %s\\n" "$*" >> "$FAKE_LOG"
if [[ "$*" == *"@auto-harness/cdk run update"* ]]; then
  touch "$FAKE_DIRECTORY/update-complete"
fi`,
  );
  executable(
    fixture.bin,
    "aws",
    `
printf "aws %s\\n" "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "dynamodb get-item")
    if [[ -f "$FAKE_DIRECTORY/update-complete" ]]; then
      [[ "\${FAKE_LEDGER_READ_FAILURE:-0}" == 1 ]] && { echo unavailable >&2; exit 1; }
      echo ACTIVITY-V1
    else
      echo None
    fi ;;
  "dynamodb scan") echo "\${FAKE_ACTIVE_SESSION_ID:-None}" ;;
  "cloudformation describe-stacks") echo AutoHarness-production-Runtime ;;
  "cloudformation list-stack-resources")
    case "$*" in
      *RestFunction*) echo rest-function ;;
      *WebSocketFunction*) echo websocket-function ;;
      *) echo cron-rule ;;
    esac ;;
  "events describe-rule") echo DISABLED ;;
  "events list-targets-by-rule") echo arn:aws:lambda:us-west-2:123:function:scheduler ;;
  "lambda get-function-concurrency")
    [[ -f "$FAKE_DIRECTORY/concurrency-fenced" ]] && echo 0 || echo None ;;
  "lambda get-function-configuration")
    case "$*" in
      *rest-function*) echo 15 ;;
      *websocket-function*) echo 30 ;;
      *) echo 1 ;;
    esac ;;
  "lambda put-function-concurrency") touch "$FAKE_DIRECTORY/concurrency-fenced" ;;
  "lambda delete-function-concurrency") rm -f "$FAKE_DIRECTORY/concurrency-fenced" ;;
  "events disable-rule"|"events enable-rule") ;;
  *) echo "unexpected aws call: $*" >&2; exit 1 ;;
esac`,
  );
}

describe("deployment wrapper contracts", () => {
  it("keeps the AWS wrapper valid Bash", () => {
    expect(spawnSync("bash", ["-n", awsScript]).status).toBe(0);
  });

  it("revalidates idleness after fencing and restores a disabled cron rule", () => {
    const fixture = fakeEnvironment();
    awsDeploymentFakes(fixture);

    const result = run(awsScript, ["--yes-first-ledger"], fixture);
    const calls = readFileSync(fixture.log, "utf8");

    expect(result.status, result.stderr).toBe(0);
    expect(position(calls, "aws events disable-rule")).toBeLessThan(
      position(calls, "aws dynamodb scan"),
    );
    expect(position(calls, "sleep 35")).toBeLessThan(position(calls, "aws dynamodb scan"));
    expect(calls).toContain("starts_with(LogicalResourceId, 'RestFunction')");
    expect(calls).toContain("starts_with(LogicalResourceId, 'WebSocketFunction')");
    expect(position(calls, "aws dynamodb scan")).toBeLessThan(
      position(calls, "pnpm --filter @auto-harness/cdk run update"),
    );
    expect(
      calls.trimEnd().endsWith("aws events disable-rule --region us-west-2 --name cron-rule"),
    ).toBe(true);
    expect(result.stdout).toContain("Verified zero drain-affecting sessions");
  });

  it("restores a disabled cron rule when ledger polling fails", () => {
    const fixture = fakeEnvironment();
    awsDeploymentFakes(fixture);

    const result = run(awsScript, ["--yes-first-ledger"], fixture, {
      FAKE_LEDGER_READ_FAILURE: "1",
    });
    const calls = readFileSync(fixture.log, "utf8");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not inspect the activity ledger");
    expect(
      calls.trimEnd().endsWith("aws events disable-rule --region us-west-2 --name cron-rule"),
    ).toBe(true);
  });

  it("refuses a drain-affecting cancelled session before updating", () => {
    const fixture = fakeEnvironment();
    awsDeploymentFakes(fixture);

    const result = run(awsScript, ["--yes-first-ledger"], fixture, {
      FAKE_ACTIVE_SESSION_ID: "cancelled-with-worktree-lease",
    });
    const calls = readFileSync(fixture.log, "utf8");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Active sessions remain after the scheduler fence");
    expect(calls).not.toContain("@auto-harness/cdk run update");
  });

  it("keeps the source-level fail-closed restoration paths", () => {
    expect(aws).toContain('original_rule_state="$(read_rule_state)"');
    expect(aws.lastIndexOf("verify_no_active_sessions")).toBeGreaterThan(
      aws.lastIndexOf('read -r -p "Scheduler stopped.'),
    );
    expect(aws).toContain(
      "#status = :cancelled AND (attribute_type(worktreeId,:stringType) OR mainCheckoutLease = :true)",
    );
    expect(aws).toContain('if [[ "$original_rule_state" == "DISABLED" ]]');
    expect(aws).toContain("trap restore_original_rule_on_exit EXIT");
    expect(aws.match(/finish_rule_restoration/g)).toHaveLength(3);
  });
});
