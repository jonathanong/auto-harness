import { spawnSync } from "node:child_process";

export type SentryBuildTarget = "host-pane" | "web";

export type SentryBuildConfig = {
  packageName: "@auto-harness/host-pane" | "@auto-harness/web";
  project: "auto-harness-control-plane-web" | "auto-harness-host-plane-web";
  release: string;
  sourceMapDirectory: string;
};

const gitSha = /^[0-9a-f]{40}$/u;

export function sentryBuildConfig(
  target: SentryBuildTarget,
  env: Record<string, string | undefined> = process.env,
): SentryBuildConfig {
  const release = env.HARNESS_SENTRY_RELEASE?.trim() ?? "";
  if (!gitSha.test(release)) {
    throw new Error("HARNESS_SENTRY_RELEASE must be an immutable 40-character git SHA");
  }
  if (target === "web") {
    return {
      packageName: "@auto-harness/web",
      project: "auto-harness-control-plane-web",
      release,
      sourceMapDirectory: "services/web/.next",
    };
  }
  return {
    packageName: "@auto-harness/host-pane",
    project: "auto-harness-host-plane-web",
    release,
    sourceMapDirectory: "services/host-pane/.next",
  };
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { env, shell: false, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited ${String(result.status)}`);
}

export function buildAndUploadSourcemaps(
  target: SentryBuildTarget,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const config = sentryBuildConfig(target, env);
  const uploadToken = env.HARNESS_SENTRY_UPLOAD_TOKEN?.trim();
  if (!uploadToken)
    throw new Error("HARNESS_SENTRY_UPLOAD_TOKEN is required when Sentry is enabled");

  // The token exists only in this exact production build process. withSentryConfig uploads and
  // deletes the generated browser maps before Next returns; no token or map enters runtime env.
  const {
    HARNESS_SENTRY_UPLOAD_TOKEN: _uploadToken,
    SENTRY_AUTH_TOKEN: _legacyToken,
    ...safeEnv
  } = env;
  const buildEnv = {
    ...safeEnv,
    HARNESS_SENTRY_UPLOAD: "1",
    HARNESS_SENTRY_RELEASE: config.release,
    SENTRY_AUTH_TOKEN: uploadToken,
    ...(target === "web" ? { HARNESS_WEB_CLOUD: "1" } : {}),
  };
  run("pnpm", ["--filter", config.packageName, "build"], buildEnv);
}

function parseTarget(value: string | undefined): SentryBuildTarget {
  if (value === "web" || value === "host-pane") return value;
  throw new Error("usage: sentry-sourcemaps.ts <web|host-pane>");
}

if (import.meta.main) {
  try {
    buildAndUploadSourcemaps(parseTarget(process.argv[2]));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
