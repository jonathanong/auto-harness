import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

type PublicDsns = Record<string, Record<string, string>>;

const requiredProjects = [
  "auto-harness-control-plane-lambda",
  "auto-harness-control-plane-web",
  "auto-harness-host-plane-backend",
  "auto-harness-host-plane-web",
] as const;

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function isPublicSentryDsn(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username.length > 0 &&
      parsed.password.length === 0 &&
      parsed.pathname.length > 1
    );
  } catch {
    return false;
  }
}

export function renderedDsnExports(environment: string, outputs: PublicDsns): string[] {
  const selected = outputs[environment];
  if (!selected) throw new Error(`Sentry state has no public DSNs for ${environment}`);
  for (const project of requiredProjects) {
    if (!isPublicSentryDsn(selected[project])) {
      throw new Error(`Sentry state has no public Sentry DSN for ${environment}/${project}`);
    }
  }
  const web = selected["auto-harness-control-plane-web"];
  const hostPane = selected["auto-harness-host-plane-web"];
  return [
    `export HARNESS_API_SENTRY_DSN=${shellQuote(selected["auto-harness-control-plane-lambda"])};`,
    `export HARNESS_WEB_SENTRY_DSN_CLIENT=${shellQuote(web)};`,
    `export HARNESS_WEB_SENTRY_DSN_SERVER=${shellQuote(web)};`,
    `export HARNESS_HOST_SENTRY_DSN=${shellQuote(selected["auto-harness-host-plane-backend"])};`,
    `export HARNESS_HOST_PANE_SENTRY_DSN_CLIENT=${shellQuote(hostPane)};`,
    `export HARNESS_HOST_PANE_SENTRY_DSN_SERVER=${shellQuote(hostPane)};`,
    "export HARNESS_SENTRY_ENABLED='1';",
  ];
}

function readOutput(directory: string): PublicDsns {
  const result = spawnSync("tofu", ["output", "-json", "public_dsn_by_environment"], {
    cwd: directory,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tofu output failed: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout) as PublicDsns;
}

if (import.meta.main) {
  try {
    const environment = process.env.HARNESS_DEPLOY_ENVIRONMENT?.trim();
    if (!environment) throw new Error("HARNESS_DEPLOY_ENVIRONMENT is required");
    const directory = resolve(process.env.HARNESS_SENTRY_TOFU_DIR?.trim() || "opentofu/sentry");
    process.stdout.write(`${renderedDsnExports(environment, readOutput(directory)).join("\n")}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
