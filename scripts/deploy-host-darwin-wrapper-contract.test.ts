import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const hostScript = new URL("deploy-host.sh", import.meta.url).pathname;
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

function runDarwinDeploy(withPersistedEnv: boolean): {
  calls: string;
  envFile: string;
  status: number | null;
  stderr: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "auto-harness-deploy-darwin-test-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  const log = join(directory, "calls.log");
  const envFile = join(directory, "Library/Application Support/auto-harness/host-daemon.env");
  mkdirSync(bin);
  writeFileSync(log, "");
  if (withPersistedEnv) {
    mkdirSync(join(envFile, ".."), { recursive: true });
    writeFileSync(envFile, "HARNESS_HOST_ID=persisted-host\n");
  }
  executable(
    bin,
    "git",
    `case "$*" in
  "branch --show-current") echo main ;;
  "status --porcelain") ;;
  "rev-parse HEAD"|"rev-parse origin/main") echo same-sha ;;
  "fetch origin main") ;;
  *) exit 1 ;;
esac`,
  );
  executable(bin, "uname", "echo Darwin");
  executable(bin, "sleep", ":");
  executable(
    bin,
    "pnpm",
    `if [[ "$*" == "local:daemon install-service" ]]; then
  printf "env-file=%s host=%s api-url=%s api-http=%s api-key=%s\\n" \\
    "\${HARNESS_ENV_FILE-}" "\${HARNESS_HOST_ID-}" "\${HARNESS_API_URL-}" \\
    "\${HARNESS_API_HTTP-}" "\${HARNESS_API_KEY-}" >> "$FAKE_LOG"
elif [[ "$*" == "local:daemon status" ]]; then
  echo '{"status":"ok"}'
fi`,
  );
  const result = spawnSync("bash", [hostScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_LOG: log,
      HARNESS_API_HTTP: "stale-http",
      HARNESS_API_KEY: "first-key",
      HARNESS_API_URL: "https://first.example.com",
      HARNESS_HOST_ID: "first-host",
      HOME: directory,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
  });
  return {
    calls: readFileSync(log, "utf8"),
    envFile,
    status: result.status,
    stderr: result.stderr,
  };
}

describe("macOS host deployment wrapper", () => {
  it("loads an existing service env without inherited identity values", () => {
    const result = runDarwinDeploy(true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toBe(`env-file=${result.envFile} host= api-url= api-http= api-key=\n`);
  });

  it("preserves first-install identity when the service env is absent", () => {
    const result = runDarwinDeploy(false);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toBe(
      "env-file= host=first-host api-url=https://first.example.com api-http=stale-http api-key=first-key\n",
    );
  });
});
