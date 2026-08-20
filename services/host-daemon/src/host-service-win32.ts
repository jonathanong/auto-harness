import { join } from "node:path";

import { renderEnvFile } from "./host-service-env.ts";
import type { HostServiceContext } from "./host-service-io.ts";
import { failedCommand, writeMode } from "./host-service-io.ts";
import {
  WINDOWS_TASK_NAME,
  renderWindowsLaunchCmd,
  windowsCreateTaskArgs,
  windowsDeleteTaskArgs,
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

export function installWin32(ctx: HostServiceContext): number {
  const paths = windowsPaths(ctx.appData);
  ctx.fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  if (ctx.fs.existsSync(paths.envFile)) {
    ctx.log(`Keeping existing env file ${paths.envFile}`);
  } else {
    writeMode(
      ctx.fs,
      paths.envFile,
      renderEnvFile(ctx.fs.readFileSync(ctx.envExamplePath), ctx.env),
      0o600,
    );
    ctx.log(`Wrote ${paths.envFile} (mode 0600)`);
  }
  writeMode(
    ctx.fs,
    paths.cmd,
    renderWindowsLaunchCmd({
      nodePath: ctx.nodePath,
      launcherPath: ctx.launcherPath,
      envFilePath: paths.envFile,
    }),
    0o700,
  );
  ctx.log(`Wrote ${paths.cmd}`);
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

export function uninstallWin32(ctx: HostServiceContext): number {
  const paths = windowsPaths(ctx.appData);
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
