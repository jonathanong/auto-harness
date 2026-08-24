import { join } from "node:path";

import { persistedEnvError } from "./host-service-env.ts";
import { preparePersistedEnv } from "./host-service-env-persisted.ts";
import type {
  HostServiceContext,
  HostServiceRunResult,
  HostServiceStatus,
} from "./host-service-io.ts";
import { failedCommand, writeMode } from "./host-service-io.ts";
import { resolveUpdateInstallDir } from "./update-install-dir.ts";
import {
  WINDOWS_TASK_NAME,
  renderWindowsLaunchCmd,
  windowsCreateTaskArgs,
  windowsDeleteTaskArgs,
  windowsEndTaskArgs,
  windowsTaskRunCommand,
} from "./host-service-templates.ts";

function windowsPaths(appData: string): { dir: string; envFile: string; cmd: string } {
  const dir = join(appData, "auto-harness");
  return {
    dir,
    envFile: join(dir, "host-daemon.env"),
    cmd: join(dir, "run-host-daemon.cmd"),
  };
}

function taskAbsent(result: HostServiceRunResult): boolean {
  return /not running|cannot find|does not exist/i.test(`${result.stderr} ${result.stdout}`);
}

export function statusWin32(ctx: HostServiceContext): HostServiceStatus {
  const result = ctx.run(
    "schtasks",
    ["/Query", "/TN", WINDOWS_TASK_NAME, "/FO", "LIST", "/V"],
    ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs },
  );
  if (result.status !== 0) {
    return taskAbsent(result)
      ? { state: "missing", reason: "scheduled task is not installed" }
      : { state: "unknown", reason: "schtasks status command failed" };
  }
  const status = /^\s*Status:\s*(.+)$/im.exec(result.stdout)?.[1]?.trim().toLowerCase();
  if (status === "running") return { state: "running", reason: "scheduled task is running" };
  if (status) return { state: "stopped", reason: "scheduled task is not running" };
  return { state: "unknown", reason: "schtasks returned an unrecognized state" };
}

function endWindowsTask(ctx: HostServiceContext): number {
  const ended = ctx.run("schtasks", windowsEndTaskArgs(WINDOWS_TASK_NAME));
  if (ended.status === 0 || taskAbsent(ended)) return 0;
  return failedCommand(ctx.error, "schtasks /End", ended);
}

export function installWin32(ctx: HostServiceContext): number {
  const paths = windowsPaths(ctx.appData);
  const envExists = ctx.fs.existsSync(paths.envFile);
  const existingEnv = envExists ? ctx.fs.readFileSync(paths.envFile) : undefined;
  const preparedEnv = preparePersistedEnv({
    existing: existingEnv,
    example: ctx.fs.readFileSync(ctx.envExamplePath),
    env: ctx.env,
    apiUrl: ctx.apiUrl,
  });
  if (preparedEnv.errors.length > 0) {
    ctx.error(persistedEnvError(preparedEnv.errors));
    return 1;
  }
  ctx.fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  if (envExists && ctx.apiUrl === undefined) {
    ctx.log(`Keeping existing env file ${paths.envFile}`);
  } else {
    writeMode(ctx.fs, paths.envFile, preparedEnv.contents, 0o600, !envExists);
    ctx.log(`${envExists ? "Updated" : "Wrote"} ${paths.envFile} (mode 0600)`);
  }
  const updateRoot = resolveUpdateInstallDir(ctx.env, {
    platform: ctx.platform,
    home: ctx.home,
    appData: ctx.appData,
  });
  const currentRoot = join(updateRoot, "current");
  writeMode(
    ctx.fs,
    paths.cmd,
    renderWindowsLaunchCmd({
      nodePath: ctx.nodePath,
      launcherPath: ctx.launcherPath,
      envFilePath: paths.envFile,
      currentRoot,
      currentLauncherPath: join(
        currentRoot,
        "services/host-daemon/bin/auto-harness-host-daemon.mjs",
      ),
      fallbackRoot: ctx.checkoutRoot,
    }),
    0o700,
  );
  ctx.log(`Wrote ${paths.cmd}`);
  if (endWindowsTask(ctx) !== 0) return 1;
  const create = ctx.run(
    "schtasks",
    windowsCreateTaskArgs({
      taskName: WINDOWS_TASK_NAME,
      command: windowsTaskRunCommand(paths.cmd),
    }),
  );
  if (create.status !== 0) return failedCommand(ctx.error, "schtasks /Create", create);
  const runNow = ctx.run("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]);
  if (runNow.status !== 0) {
    ctx.log(
      `Task created but schtasks /Run failed: ${runNow.stderr.trim() || runNow.stdout.trim()}`,
    );
  }
  ctx.log(`Registered scheduled task ${WINDOWS_TASK_NAME} at logon for the current user`);
  return 0;
}

export function restartWin32(ctx: HostServiceContext): number {
  if (endWindowsTask(ctx) !== 0) return 1;
  const runNow = ctx.run("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]);
  if (runNow.status !== 0) return failedCommand(ctx.error, "schtasks /Run", runNow);
  ctx.log(`Restarted scheduled task ${WINDOWS_TASK_NAME}`);
  return 0;
}

export function uninstallWin32(ctx: HostServiceContext): number {
  const paths = windowsPaths(ctx.appData);
  if (endWindowsTask(ctx) !== 0) return 1;
  const del = ctx.run("schtasks", windowsDeleteTaskArgs(WINDOWS_TASK_NAME));
  if (del.status !== 0) {
    const msg = `${del.stderr} ${del.stdout}`;
    if (!/cannot find|does not exist/i.test(msg)) {
      return failedCommand(ctx.error, "schtasks /Delete", del);
    }
  }
  if (ctx.fs.existsSync(paths.cmd)) {
    ctx.fs.rmSync(paths.cmd, { force: true });
    ctx.log(`Removed ${paths.cmd}`);
  }
  ctx.log(`Removed scheduled task ${WINDOWS_TASK_NAME} (checkout and env file left in place)`);
  return 0;
}
