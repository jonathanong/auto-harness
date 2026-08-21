import { join } from "node:path";

import { persistedEnvError } from "./host-service-env.ts";
import { preparePersistedEnv } from "./host-service-env-persisted.ts";
import type { HostServiceContext, HostServiceStatus } from "./host-service-io.ts";
import { failedCommand, writeMode } from "./host-service-io.ts";
import {
  LINUX_ENABLE_NOW_COMMAND,
  LINUX_ENV_DEST,
  LINUX_ENV_DIR,
  LINUX_OPT_CURRENT,
  LINUX_RELOAD_COMMAND,
  LINUX_SERVICE_NAME,
  LINUX_UNIT_DEST,
  renderLinuxUnit,
} from "./host-service-templates.ts";

function linuxWorkingDirectory(ctx: HostServiceContext): string {
  return ctx.fs.existsSync(LINUX_OPT_CURRENT) ? LINUX_OPT_CURRENT : ctx.checkoutRoot;
}

function renderedUnit(ctx: HostServiceContext): string {
  return renderLinuxUnit(ctx.fs.readFileSync(ctx.unitTemplatePath), linuxWorkingDirectory(ctx));
}

function stageRoot(ctx: HostServiceContext): string {
  return ctx.env.XDG_RUNTIME_DIR?.trim() || ctx.tmpDir;
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

export function installLinux(ctx: HostServiceContext): number {
  const envExists = ctx.fs.existsSync(LINUX_ENV_DEST);
  if (ctx.uid !== 0 && envExists && ctx.apiUrl === undefined) {
    const unit = renderedUnit(ctx);
    const stagedDir = ctx.fs.mkdtempSync(join(stageRoot(ctx), "auto-harness-host-service-"));
    const stagedUnit = join(stagedDir, LINUX_SERVICE_NAME);
    writeMode(ctx.fs, stagedUnit, unit, 0o644, true);
    ctx.log(`Wrote ${stagedUnit}`);
    ctx.log(`Staged in ephemeral directory ${stagedDir}`);
    ctx.log("Not running as root. Run:");
    ctx.log(`  sudo install -d -m 0755 ${LINUX_ENV_DIR}`);
    ctx.log(`  sudo install -m 0644 ${stagedUnit} ${LINUX_UNIT_DEST}`);
    ctx.log(`  sudo ${LINUX_RELOAD_COMMAND}`);
    ctx.log(`  sudo ${LINUX_ENABLE_NOW_COMMAND}`);
    return 0;
  }
  if (ctx.uid !== 0 && envExists && ctx.apiUrl !== undefined) {
    ctx.error(
      "Refusing --api-url update as non-root: rerun install-service with sudo to retain the persisted service key safely.",
    );
    return 1;
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
    return 1;
  }
  const unit = renderedUnit(ctx);
  const writeEnv = !envExists || ctx.apiUrl !== undefined;
  if (ctx.uid !== 0) {
    const stagedDir = ctx.fs.mkdtempSync(join(stageRoot(ctx), "auto-harness-host-service-"));
    const stagedUnit = join(stagedDir, LINUX_SERVICE_NAME);
    const stagedEnv = join(stagedDir, "host-daemon.env");
    writeMode(ctx.fs, stagedUnit, unit, 0o644, true);
    ctx.log(`Wrote ${stagedUnit}`);
    if (writeEnv) {
      writeMode(ctx.fs, stagedEnv, preparedEnv.contents, 0o600, true);
      ctx.log(`Wrote ${stagedEnv} (mode 0600)`);
    }
    ctx.log(`Staged in ephemeral directory ${stagedDir}`);
    ctx.log("Not running as root. Run:");
    ctx.log(`  sudo install -d -m 0755 ${LINUX_ENV_DIR}`);
    if (writeEnv) {
      ctx.log(`  sudo install -m 0600 ${stagedEnv} ${LINUX_ENV_DEST}`);
    }
    ctx.log(`  sudo install -m 0644 ${stagedUnit} ${LINUX_UNIT_DEST}`);
    ctx.log(`  sudo ${LINUX_RELOAD_COMMAND}`);
    ctx.log(`  sudo ${LINUX_ENABLE_NOW_COMMAND}`);
    return 0;
  }

  ctx.fs.mkdirSync(LINUX_ENV_DIR, { recursive: true, mode: 0o755 });
  if (writeEnv) {
    writeMode(ctx.fs, LINUX_ENV_DEST, preparedEnv.contents, 0o600, !envExists);
    ctx.log(`${envExists ? "Updated" : "Wrote"} ${LINUX_ENV_DEST} (mode 0600)`);
  } else {
    ctx.log(`Keeping existing env file ${LINUX_ENV_DEST}`);
  }
  writeMode(ctx.fs, LINUX_UNIT_DEST, unit, 0o644);
  ctx.log(`Wrote ${LINUX_UNIT_DEST}`);
  const reload = ctx.run("systemctl", ["daemon-reload"]);
  if (reload.status !== 0) return failedCommand(ctx.error, "systemctl daemon-reload", reload);
  if (ctx.apiUrl !== undefined && envExists) {
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
