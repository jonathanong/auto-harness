import { join } from "node:path";

import { renderEnvFile, warnOrRefuseIdentity } from "./host-service-env.ts";
import type { HostServiceContext } from "./host-service-io.ts";
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

function renderedEnv(ctx: HostServiceContext): string {
  return renderEnvFile(ctx.fs.readFileSync(ctx.envExamplePath), ctx.env, { capturePath: false });
}

function renderedUnit(ctx: HostServiceContext): string {
  return renderLinuxUnit(ctx.fs.readFileSync(ctx.unitTemplatePath), linuxWorkingDirectory(ctx));
}

function stageRoot(ctx: HostServiceContext): string {
  return ctx.env.XDG_RUNTIME_DIR?.trim() || ctx.tmpDir;
}

export function installLinux(ctx: HostServiceContext): number {
  const unit = renderedUnit(ctx);
  const envMissing = !ctx.fs.existsSync(LINUX_ENV_DEST);
  if (envMissing && warnOrRefuseIdentity(ctx) !== 0) return 1;

  if (ctx.uid !== 0) {
    const stagedDir = ctx.fs.mkdtempSync(join(stageRoot(ctx), "auto-harness-host-service-"));
    const stagedUnit = join(stagedDir, LINUX_SERVICE_NAME);
    const stagedEnv = join(stagedDir, "host-daemon.env");
    writeMode(ctx.fs, stagedUnit, unit, 0o644, true);
    ctx.log(`Wrote ${stagedUnit}`);
    if (envMissing) {
      writeMode(ctx.fs, stagedEnv, renderedEnv(ctx), 0o600, true);
      ctx.log(`Wrote ${stagedEnv} (mode 0600)`);
    }
    ctx.log(`Staged in ephemeral directory ${stagedDir}`);
    ctx.log("Not running as root. Run:");
    ctx.log(`  sudo install -d -m 0755 ${LINUX_ENV_DIR}`);
    if (envMissing) {
      ctx.log(`  sudo install -m 0600 ${stagedEnv} ${LINUX_ENV_DEST}`);
    }
    ctx.log(`  sudo install -m 0644 ${stagedUnit} ${LINUX_UNIT_DEST}`);
    ctx.log(`  sudo ${LINUX_RELOAD_COMMAND}`);
    ctx.log(`  sudo ${LINUX_ENABLE_NOW_COMMAND}`);
    return 0;
  }

  ctx.fs.mkdirSync(LINUX_ENV_DIR, { recursive: true, mode: 0o755 });
  if (envMissing) {
    writeMode(ctx.fs, LINUX_ENV_DEST, renderedEnv(ctx), 0o600, true);
    ctx.log(`Wrote ${LINUX_ENV_DEST} (mode 0600)`);
  } else {
    ctx.log(`Keeping existing env file ${LINUX_ENV_DEST}`);
  }
  writeMode(ctx.fs, LINUX_UNIT_DEST, unit, 0o644);
  ctx.log(`Wrote ${LINUX_UNIT_DEST}`);
  const reload = ctx.run("systemctl", ["daemon-reload"]);
  if (reload.status !== 0) return failedCommand(ctx.error, "systemctl daemon-reload", reload);
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
