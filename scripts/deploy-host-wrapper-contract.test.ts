import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const hostScript = new URL("deploy-host.sh", import.meta.url).pathname;
const host = readFileSync(hostScript, "utf8");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function executable(bin: string, name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}

function fakeEnvironment(): { bin: string; directory: string; log: string } {
  const directory = mkdtempSync(join(tmpdir(), "auto-harness-deploy-host-test-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  const log = join(directory, "calls.log");
  writeFileSync(log, "");
  mkdirSync(bin);
  return { bin, directory, log };
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

describe("host deployment wrapper contracts", () => {
  it("keeps the host wrapper valid Bash", () => {
    expect(spawnSync("bash", ["-n", hostScript]).status).toBe(0);
  });

  it("installs native dependencies and polls host readiness", () => {
    const fixture = fakeEnvironment();
    baseFakes(fixture.bin);
    executable(fixture.bin, "uname", "echo Darwin");
    executable(
      fixture.bin,
      "pnpm",
      `
printf "pnpm %s\\n" "$*" >> "$FAKE_LOG"
if [[ "$*" == "local:daemon status" ]]; then
  count_file="$FAKE_DIRECTORY/status-count"
  count=0
  if [[ -f "$count_file" ]]; then
    count="$(cat "$count_file")"
  fi
  count=$((count + 1))
  printf "%s" "$count" > "$count_file"
  if [[ "$count" -lt 3 ]]; then
    echo "host not registered yet" >&2
    exit 1
  fi
  echo '{"status":"ok"}'
fi`,
    );

    const result = spawnSync("bash", [hostScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_DIRECTORY: fixture.directory,
        FAKE_LOG: fixture.log,
        HOME: fixture.directory,
        PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      },
    });
    const calls = readFileSync(fixture.log, "utf8");

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain("pnpm install --frozen-lockfile\n");
    expect(calls).not.toContain("--ignore-scripts");
    expect(calls.match(/pnpm local:daemon status/g)).toHaveLength(3);
    expect(result.stdout).toContain('{"status":"ok"}');
  });

  it("binds Linux activation to the checkout systemd will execute", () => {
    expect(host).toContain('service_root="$(cd /opt/auto-harness/current && pwd -P)"');
    expect(host).toContain('if [[ "$checkout_root" != "$service_root" ]]');
    expect(host).toContain("Host service did not become ready within 120 seconds.");
  });
});
