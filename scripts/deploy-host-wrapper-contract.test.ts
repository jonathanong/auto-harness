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

function position(source: string, fragment: string): number {
  const index = source.indexOf(fragment);
  expect(index, `missing script contract: ${fragment}`).toBeGreaterThanOrEqual(0);
  return index;
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
    expect(calls).toContain("pnpm install --frozen-lockfile --ignore-scripts\n");
    expect(calls).toContain("pnpm rebuild node-pty\n");
    expect(calls.match(/pnpm local:daemon status/g)).toHaveLength(3);
    expect(result.stdout).toContain('{"status":"ok"}');
  });

  it("rejects a mismatched Linux service checkout before activation", () => {
    const fixture = fakeEnvironment();
    const serviceRoot = join(fixture.directory, "service-checkout");
    mkdirSync(serviceRoot);

    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; validate_linux_checkout Linux "$2" "$3"',
        "deploy-host-test",
        hostScript,
        fixture.directory,
        serviceRoot,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("deploy:host must run from");
    expect(position(host, "validate_linux_checkout")).toBeLessThan(
      position(host, "pnpm install --frozen-lockfile"),
    );
  });

  it("rejects a relative Linux update root before changing the checkout", () => {
    const result = spawnSync("bash", [hostScript], {
      encoding: "utf8",
      env: { ...process.env, HARNESS_UPDATE_INSTALL_DIR: "updates" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HARNESS_UPDATE_INSTALL_DIR must be an absolute path.");
    expect(position(host, 'update_root="${HARNESS_UPDATE_INSTALL_DIR')).toBeLessThan(
      position(host, "git fetch origin main"),
    );
  });

  it("terminates a status command at the end-to-end readiness deadline", () => {
    const fixture = fakeEnvironment();
    executable(fixture.bin, "never-ready", 'trap "" TERM\n/bin/sleep 30');
    const startedAt = Date.now();

    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; wait_for_host_readiness 1 "$2"',
        "deploy-host-test",
        hostScript,
        join(fixture.bin, "never-ready"),
      ],
      { encoding: "utf8", timeout: 5_000 },
    );

    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(result.stderr).toContain("within 1 seconds");
  });

  it("binds Linux deployment to the writable staging checkout", () => {
    expect(host).toContain('service_root="$(cd "$service_checkout" && pwd -P)"');
    expect(host).toContain('if [[ "$checkout_root" != "$service_root" ]]');
    expect(host).toContain('update_root="${HARNESS_UPDATE_INSTALL_DIR:-/opt/auto-harness}"');
    expect(host).toContain(
      'validate_linux_checkout "$platform" "$(pwd -P)" "$update_root/staging"',
    );
    expect(host).toContain("configured signed updater writes incoming/");
    expect(host).toContain("wait_for_host_readiness 120");
  });
});
