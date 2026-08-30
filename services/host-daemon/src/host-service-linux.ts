/* eslint-disable max-lines -- Linux install, staging, and update handoff share one service contract. */
import { dirname, join } from "node:path";

import { persistedEnvError } from "./host-service-env.ts";
import { preparePersistedEnv } from "./host-service-env-persisted.ts";
import type { HostServiceContext, HostServiceStatus } from "./host-service-io.ts";
import { failedCommand, writeMode } from "./host-service-io.ts";
import { resolveUpdateInstallDir } from "./update-install-dir.ts";
import {
  LINUX_ENABLE_NOW_COMMAND,
  LINUX_ACTIVATION_HELPER_DEST,
  LINUX_ENV_DEST,
  LINUX_ENV_DIR,
  LINUX_LAUNCHER_DEST,
  LINUX_RELOAD_COMMAND,
  LINUX_SERVICE_NAME,
  LINUX_UNIT_DEST,
  renderLinuxUnit,
  renderUnixLaunchScript,
} from "./host-service-templates.ts";

type LinuxPaths = {
  updateRoot: string;
  currentRoot: string;
  stagingRoot: string;
  launcher: string;
};

// Keep this in sync with the checked-in systemd unit. The daemon runs as this
// unprivileged account, so it owns only its incoming artifacts and deployment
// staging checkout; the root-owned active release remains immutable.
const LINUX_SERVICE_USER = "harness";

function linuxPaths(ctx: HostServiceContext): LinuxPaths {
  const updateRoot = resolveUpdateInstallDir(ctx.env, {
    platform: ctx.platform,
    home: ctx.home,
    appData: ctx.appData,
  });
  return {
    updateRoot,
    currentRoot: join(updateRoot, "current"),
    stagingRoot: join(updateRoot, "staging"),
    launcher: LINUX_LAUNCHER_DEST,
  };
}

function linuxWorkingDirectory(ctx: HostServiceContext, currentRoot: string): string {
  return ctx.fs.existsSync(currentRoot) ? currentRoot : ctx.checkoutRoot;
}

function renderedUnit(ctx: HostServiceContext, paths: LinuxPaths): string {
  return renderLinuxUnit(
    ctx.fs.readFileSync(ctx.unitTemplatePath),
    linuxWorkingDirectory(ctx, paths.currentRoot),
    paths.launcher,
  );
}

function renderedLauncher(ctx: HostServiceContext, paths: LinuxPaths): string {
  return renderUnixLaunchScript({
    currentRoot: paths.currentRoot,
    currentLauncherPath: join(
      paths.currentRoot,
      "services/host-daemon/bin/auto-harness-host-daemon.mjs",
    ),
    fallbackRoot: ctx.checkoutRoot,
    fallbackLauncherPath: ctx.launcherPath,
  });
}

function stageRoot(ctx: HostServiceContext): string {
  return ctx.env.XDG_RUNTIME_DIR?.trim() || ctx.tmpDir;
}

/** Quote a single argv value for the copy-and-paste POSIX shell instructions. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function statusLinux(ctx: HostServiceContext): HostServiceStatus {
  const result = ctx.run(
    "systemctl",
    ["show", "--no-pager", "--property=LoadState,ActiveState,SubState,Result", LINUX_SERVICE_NAME],
    ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs },
  );
  const values = new Map<string, string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  if (values.get("LoadState") === "not-found") {
    return { state: "missing", reason: "systemd unit is not installed" };
  }
  if (result.status !== 0) return { state: "unknown", reason: "systemctl status command failed" };
  if (values.get("ActiveState") === "active" && values.get("SubState") === "running") {
    return { state: "running", reason: "systemd unit is running" };
  }
  if (values.get("ActiveState") === "inactive") {
    return { state: "stopped", reason: "systemd unit is inactive" };
  }
  if (values.get("ActiveState") === "failed" || values.get("Result") === "failed") {
    return { state: "failed", reason: "systemd unit reported failure" };
  }
  return { state: "unknown", reason: "systemctl returned an unrecognized state" };
}

function stageLinux(
  ctx: HostServiceContext,
  paths: LinuxPaths,
  unit: string,
  launcher: string,
  envContents?: string,
): number {
  const stagedDir = ctx.fs.mkdtempSync(join(stageRoot(ctx), "auto-harness-host-service-"));
  const stagedUnit = join(stagedDir, LINUX_SERVICE_NAME);
  const stagedEnv = join(stagedDir, "host-daemon.env");
  const stagedLauncher = join(stagedDir, "run-host-daemon.sh");
  const stagedHelper = join(stagedDir, "promote-host-daemon-update.mjs");
  writeMode(ctx.fs, stagedUnit, unit, 0o644, true);
  writeMode(ctx.fs, stagedLauncher, launcher, 0o755, true);
  writeMode(
    ctx.fs,
    stagedHelper,
    ctx.fs.readFileSync(ctx.activationHelperTemplatePath),
    0o755,
    true,
  );
  ctx.log(`Wrote ${stagedUnit}`);
  ctx.log(`Wrote ${stagedLauncher}`);
  ctx.log(`Wrote ${stagedHelper}`);
  if (envContents !== undefined) {
    writeMode(ctx.fs, stagedEnv, envContents, 0o600, true);
    ctx.log(`Wrote ${stagedEnv} (mode 0600)`);
  }
  ctx.log(`Staged in ephemeral directory ${stagedDir}`);
  ctx.log("Not running as root. Run:");
  ctx.log(`  sudo install -d -m 0755 ${shellQuote(LINUX_ENV_DIR)}`);
  ctx.log(`  sudo install -d -o root -g root -m 0755 ${shellQuote(paths.updateRoot)}`);
  ctx.log(
    `  sudo install -d -o ${LINUX_SERVICE_USER} -g ${LINUX_SERVICE_USER} -m 0700 ${shellQuote(join(paths.updateRoot, "incoming"))}`,
  );
  ctx.log(
    `  sudo install -d -o ${LINUX_SERVICE_USER} -g ${LINUX_SERVICE_USER} -m 0700 ${shellQuote(paths.stagingRoot)}`,
  );
  ctx.log(`  sudo install -d -o root -g root -m 0755 ${shellQuote(dirname(paths.launcher))}`);
  if (envContents !== undefined) {
    ctx.log(`  sudo install -m 0600 ${shellQuote(stagedEnv)} ${shellQuote(LINUX_ENV_DEST)}`);
  }
  ctx.log(`  sudo install -m 0755 ${shellQuote(stagedLauncher)} ${shellQuote(paths.launcher)}`);
  ctx.log(
    `  sudo install -m 0755 ${shellQuote(stagedHelper)} ${shellQuote(LINUX_ACTIVATION_HELPER_DEST)}`,
  );
  ctx.log(`  sudo install -m 0644 ${shellQuote(stagedUnit)} ${shellQuote(LINUX_UNIT_DEST)}`);
  ctx.log(`  sudo ${LINUX_RELOAD_COMMAND}`);
  ctx.log(`  sudo ${LINUX_ENABLE_NOW_COMMAND}`);
  return 0;
}

function activateLinux(ctx: HostServiceContext, envExists: boolean): number {
  if (envExists) {
    const enable = ctx.run("systemctl", ["enable", LINUX_SERVICE_NAME]);
    if (enable.status !== 0) return failedCommand(ctx.error, "systemctl enable", enable);
    const restart = ctx.run("systemctl", ["restart", LINUX_SERVICE_NAME]);
    if (restart.status !== 0) return failedCommand(ctx.error, "systemctl restart", restart);
    ctx.log(`Enabled and restarted ${LINUX_SERVICE_NAME}`);
    return 0;
  }
  const enable = ctx.run("systemctl", ["enable", "--now", LINUX_SERVICE_NAME]);
  if (enable.status !== 0) return failedCommand(ctx.error, "systemctl enable", enable);
  ctx.log(`Enabled ${LINUX_SERVICE_NAME}`);
  return 0;
}

type LinuxInstall = {
  envExists: boolean;
  preparedEnv: ReturnType<typeof preparePersistedEnv>;
  paths: LinuxPaths;
  unit: string;
  launcher: string;
  writeEnv: boolean;
};

function prepareLinuxInstall(ctx: HostServiceContext): LinuxInstall | undefined {
  const envExists = ctx.fs.existsSync(LINUX_ENV_DEST);
  if (ctx.uid !== 0 && envExists) {
    ctx.error(
      ctx.apiUrl === undefined
        ? "Refusing non-root install with an existing service env: rerun install-service with sudo so the persisted environment can be validated safely."
        : "Refusing --api-url update as non-root: rerun install-service with sudo to retain the persisted service key safely.",
    );
    return undefined;
  }
  const existingEnv = envExists ? ctx.fs.readFileSync(LINUX_ENV_DEST) : undefined;
  const preparedEnv = preparePersistedEnv({
    existing: existingEnv,
    example: ctx.fs.readFileSync(ctx.envExamplePath),
    env: ctx.env,
    apiUrl: ctx.apiUrl,
    capturePath: false,
  });
  if (preparedEnv.errors.length > 0) {
    ctx.error(persistedEnvError(preparedEnv.errors));
    return undefined;
  }
  const paths = linuxPaths(ctx);
  const unit = renderedUnit(ctx, paths);
  const launcher = renderedLauncher(ctx, paths);
  const writeEnv = !envExists || ctx.apiUrl !== undefined || preparedEnv.contents !== existingEnv;
  return { envExists, preparedEnv, paths, unit, launcher, writeEnv };
}

function installLinuxDirectory(
  ctx: HostServiceContext,
  target: string,
  owner: string,
  mode: string,
  description: string,
): boolean {
  const result = ctx.run("install", ["-d", "-o", owner, "-g", owner, "-m", mode, target]);
  return result.status === 0 || (failedCommand(ctx.error, description, result), false);
}

function installLinuxRoots(ctx: HostServiceContext, paths: LinuxPaths): boolean {
  return (
    installLinuxDirectory(ctx, paths.updateRoot, "root", "0755", "install writable update root") &&
    installLinuxDirectory(
      ctx,
      join(paths.updateRoot, "incoming"),
      LINUX_SERVICE_USER,
      "0700",
      "install writable update incoming directory",
    ) &&
    installLinuxDirectory(
      ctx,
      paths.stagingRoot,
      LINUX_SERVICE_USER,
      "0700",
      "install writable deployment staging directory",
    ) &&
    installLinuxDirectory(
      ctx,
      dirname(paths.launcher),
      "root",
      "0755",
      "install root-owned launcher directory",
    ) &&
    installLinuxDirectory(
      ctx,
      join(paths.updateRoot, "releases"),
      "root",
      "0755",
      "install immutable update release directory",
    )
  );
}

function lockLinuxReleaseTree(ctx: HostServiceContext, path: string, description: string): boolean {
  const ownership = ctx.run("chown", ["-R", "root:root", path]);
  if (ownership.status !== 0) {
    failedCommand(ctx.error, `lock ${description} ownership`, ownership);
    return false;
  }
  const permissions = ctx.run("chmod", ["-R", "go-w", path]);
  return (
    permissions.status === 0 ||
    (failedCommand(ctx.error, `lock ${description} permissions`, permissions), false)
  );
}

function lockLegacyLinuxReleaseTrees(ctx: HostServiceContext, paths: LinuxPaths): boolean {
  // Migrate a checkout installed by earlier versions, where `current` was
  // harness-owned. A root-owned wrapper must never execute a release that a
  // session CLI can still replace between service starts.
  if (
    ctx.fs.existsSync(paths.currentRoot) &&
    !lockLinuxReleaseTree(ctx, paths.currentRoot, "existing current release")
  ) {
    return false;
  }
  // Earlier automatic-update builds used current -> versions/<version>.
  // `chown -R current` deliberately does not dereference that pointer, so
  // lock its target tree explicitly before a root-owned wrapper may follow it.
  const legacyVersions = join(paths.updateRoot, "versions");
  return (
    !ctx.fs.existsSync(legacyVersions) ||
    lockLinuxReleaseTree(ctx, legacyVersions, "legacy update release")
  );
}

function writeLinuxServiceFiles(ctx: HostServiceContext, install: LinuxInstall): void {
  const { envExists, preparedEnv, paths, unit, launcher, writeEnv } = install;
  if (writeEnv) {
    writeMode(ctx.fs, LINUX_ENV_DEST, preparedEnv.contents, 0o600, !envExists);
    ctx.log(`${envExists ? "Updated" : "Wrote"} ${LINUX_ENV_DEST} (mode 0600)`);
  } else {
    ctx.log(`Keeping existing env file ${LINUX_ENV_DEST}`);
  }
  writeMode(ctx.fs, paths.launcher, launcher, 0o755);
  ctx.log(`Wrote ${paths.launcher}`);
  writeMode(
    ctx.fs,
    LINUX_ACTIVATION_HELPER_DEST,
    ctx.fs.readFileSync(ctx.activationHelperTemplatePath),
    0o755,
  );
  ctx.log(`Wrote ${LINUX_ACTIVATION_HELPER_DEST}`);
  writeMode(ctx.fs, LINUX_UNIT_DEST, unit, 0o644);
  ctx.log(`Wrote ${LINUX_UNIT_DEST}`);
}

export function installLinux(ctx: HostServiceContext): number {
  const install = prepareLinuxInstall(ctx);
  if (!install) return 1;
  const { envExists, preparedEnv, paths, unit, launcher, writeEnv } = install;
  if (ctx.uid !== 0) {
    return stageLinux(ctx, paths, unit, launcher, writeEnv ? preparedEnv.contents : undefined);
  }

  ctx.fs.mkdirSync(LINUX_ENV_DIR, { recursive: true, mode: 0o755 });
  if (!installLinuxRoots(ctx, paths) || !lockLegacyLinuxReleaseTrees(ctx, paths)) return 1;
  writeLinuxServiceFiles(ctx, install);
  const reload = ctx.run("systemctl", ["daemon-reload"]);
  if (reload.status !== 0) return failedCommand(ctx.error, "systemctl daemon-reload", reload);
  return activateLinux(ctx, envExists);
}

export function restartLinux(ctx: HostServiceContext): number {
  if (!ctx.restartHandoff) {
    ctx.error(
      "Linux automatic update restart requires the daemon process handoff; refusing an unprivileged systemctl restart.",
    );
    return 1;
  }
  ctx.restartHandoff();
  ctx.log(`Requested daemon exit; systemd Restart=always will restart ${LINUX_SERVICE_NAME}`);
  return 0;
}

export function uninstallLinux(ctx: HostServiceContext): number {
  if (ctx.uid !== 0) {
    ctx.log("Not running as root. Run:");
    ctx.log(`  sudo systemctl disable --now ${LINUX_SERVICE_NAME}`);
    ctx.log(`  sudo rm -f ${LINUX_UNIT_DEST}`);
    ctx.log(`  sudo ${LINUX_RELOAD_COMMAND}`);
    return 0;
  }
  ctx.run("systemctl", ["disable", "--now", LINUX_SERVICE_NAME]);
  if (ctx.fs.existsSync(LINUX_UNIT_DEST)) {
    ctx.fs.rmSync(LINUX_UNIT_DEST, { force: true });
    ctx.log(`Removed ${LINUX_UNIT_DEST}`);
  }
  const reload = ctx.run("systemctl", ["daemon-reload"]);
  if (reload.status !== 0) return failedCommand(ctx.error, "systemctl daemon-reload", reload);
  ctx.log(`Disabled ${LINUX_SERVICE_NAME} (env file left in place)`);
  return 0;
}
