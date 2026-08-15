import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const serviceUrl = new URL(
  "../services/host-daemon/systemd/auto-harness-host-daemon.service",
  import.meta.url,
);
export const envExampleUrl = new URL(
  "../services/host-daemon/systemd/host-daemon.env.example",
  import.meta.url,
);

const REQUIRED_SERVICE_LINES = [
  "Documentation=https://github.com/jonathanong/auto-harness/blob/main/docs/deploy-host-daemon.md",
  "Type=simple",
  "Wants=network-online.target",
  "After=network-online.target",
  "User=harness",
  "Group=harness",
  "WorkingDirectory=/opt/auto-harness/current",
  "EnvironmentFile=/etc/auto-harness/host-daemon.env",
  "ExecStart=/usr/bin/env node services/host-daemon/bin/auto-harness-host-daemon.mjs start",
  "Restart=always",
  "RestartSec=5s",
  "TimeoutStopSec=infinity",
  "KillMode=mixed",
  "UMask=0077",
  "NoNewPrivileges=true",
  "WantedBy=multi-user.target",
] as const;

const REQUIRED_ENV_NAMES = [
  "PATH",
  "HARNESS_HOST_ID",
  "HARNESS_API_URL",
  "HARNESS_API_KEY",
  "HARNESS_LOG_LEVEL",
  "HARNESS_CHILD_ENV_ALLOWLIST",
] as const;

export function validateSystemdArtifacts(service: string, envExample: string): string[] {
  const errors: string[] = [];
  const lines = new Set(service.split(/\r?\n/));
  for (const line of REQUIRED_SERVICE_LINES) {
    if (!lines.has(line)) errors.push(`missing service directive: ${line}`);
  }
  for (const forbidden of ["Type=notify", "WatchdogSec=", "ExecReload=", "pnpm ", "sh -c"]) {
    if (service.includes(forbidden)) errors.push(`forbidden service behavior: ${forbidden}`);
  }

  const configuredEnvNames = new Set(
    envExample
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.slice(0, line.indexOf("="))),
  );
  for (const name of REQUIRED_ENV_NAMES) {
    if (!configuredEnvNames.has(name)) errors.push(`missing environment example: ${name}`);
  }
  if (/hns_[A-Za-z0-9_-]+/.test(envExample)) {
    errors.push("environment example contains a service-account-shaped secret");
  }
  return errors;
}

function main(): void {
  const service = readFileSync(serviceUrl, "utf8");
  const envExample = readFileSync(envExampleUrl, "utf8");
  const errors = validateSystemdArtifacts(service, envExample);
  if (errors.length > 0) throw new Error(errors.join("\n"));

  const verify = spawnSync("systemd-analyze", ["verify", fileURLToPath(serviceUrl)], {
    encoding: "utf8",
  });
  if (verify.error && "code" in verify.error && verify.error.code === "ENOENT") {
    console.log(
      "systemd service contract valid (systemd-analyze unavailable; syntax check skipped)",
    );
    return;
  }
  if (verify.error) throw verify.error;
  if (verify.status !== 0) {
    throw new Error(`systemd-analyze verify failed:\n${verify.stderr || verify.stdout}`);
  }
  console.log("systemd service contract and systemd-analyze verification passed");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
