import { join } from "node:path";

import { activateLaunchAgent, kickstartAndVerify } from "./host-service-darwin-activate.ts";
import { inspectDarwin, launchDomain } from "./host-service-darwin-inspect.ts";
import { pathFromEnv, persistedEnvError } from "./host-service-env.ts";
import { preparePersistedEnv } from "./host-service-env-persisted.ts";
import type { HostServiceContext } from "./host-service-io.ts";
import { writeMode } from "./host-service-io.ts";
import { resolveUpdateInstallDir } from "./update-install-dir.ts";
import {
  DARWIN_LABEL,
  renderLaunchAgentPlist,
  renderUnixLaunchScript,
} from "./host-service-templates.ts";

export { statusDarwin } from "./host-service-darwin-inspect.ts";

function darwinPaths(home: string): {
  plist: string;
  envFile: string;
  launcher: string;
  log: string;
  agentsDir: string;
  supportDir: string;
} {
  const supportDir = join(home, "Library/Application Support/auto-harness");
  return {
    plist: join(home, "Library/LaunchAgents/com.auto-harness.host-daemon.plist"),
    envFile: join(supportDir, "host-daemon.env"),
    launcher: join(supportDir, "run-host-daemon.sh"),
    log: join(home, "Library/Logs/auto-harness-host-daemon.log"),
    agentsDir: join(home, "Library/LaunchAgents"),
    supportDir,
  };
}

function renderDarwinLauncher(ctx: HostServiceContext): string {
  const updateRoot = resolveUpdateInstallDir(ctx.env, {
    platform: ctx.platform,
    home: ctx.home,
    appData: ctx.appData,
  });
  const currentRoot = join(updateRoot, "current");
  return renderUnixLaunchScript({
    currentRoot,
    currentLauncherPath: join(currentRoot, "services/host-daemon/bin/auto-harness-host-daemon.mjs"),
    fallbackRoot: ctx.checkoutRoot,
    fallbackLauncherPath: ctx.launcherPath,
    prepareLauncherPath: ctx.launcherPath,
  });
}

export function installDarwin(ctx: HostServiceContext): number {
  const paths = darwinPaths(ctx.home);
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
  ctx.fs.mkdirSync(paths.agentsDir, { recursive: true, mode: 0o755 });
  ctx.fs.mkdirSync(paths.supportDir, { recursive: true, mode: 0o755 });
  if (envExists && ctx.apiUrl === undefined && preparedEnv.contents === existingEnv) {
    ctx.log(`Keeping existing env file ${paths.envFile}`);
  } else {
    writeMode(ctx.fs, paths.envFile, preparedEnv.contents, 0o600, !envExists);
    ctx.log(`${envExists ? "Updated" : "Wrote"} ${paths.envFile} (mode 0600)`);
  }
  writeMode(ctx.fs, paths.launcher, renderDarwinLauncher(ctx), 0o700);
  ctx.log(`Wrote ${paths.launcher}`);
  writeMode(
    ctx.fs,
    paths.plist,
    renderLaunchAgentPlist({
      nodePath: ctx.nodePath,
      launcherPath: ctx.launcherPath,
      checkoutRoot: ctx.checkoutRoot,
      home: ctx.home,
      envFilePath: paths.envFile,
      pathValue: pathFromEnv(ctx.env) ?? "/usr/local/bin:/usr/bin:/bin",
      logPath: paths.log,
      programArguments: ["/bin/sh", paths.launcher],
    }),
    0o644,
  );
  ctx.log(`Wrote ${paths.plist}`);
  const domain = launchDomain(ctx.uid);
  const service = `${domain}/${DARWIN_LABEL}`;
  const activated = activateLaunchAgent(ctx, domain, paths.plist, service);
  if (activated !== 0) return activated;
  ctx.log(`Enabled LaunchAgent ${DARWIN_LABEL} as the current user`);
  return 0;
}

export function restartDarwin(ctx: HostServiceContext): number {
  const service = `${launchDomain(ctx.uid)}/${DARWIN_LABEL}`;
  const restarted = kickstartAndVerify(ctx, service, inspectDarwin(ctx).pid);
  if (restarted !== 0) return restarted;
  ctx.log(`Restarted LaunchAgent ${DARWIN_LABEL}`);
  return 0;
}

export function uninstallDarwin(ctx: HostServiceContext): number {
  const paths = darwinPaths(ctx.home);
  const domain = launchDomain(ctx.uid);
  ctx.run("launchctl", ["bootout", `${domain}/${DARWIN_LABEL}`]);
  ctx.run("launchctl", ["unload", "-w", paths.plist]);
  if (ctx.fs.existsSync(paths.plist)) {
    ctx.fs.rmSync(paths.plist, { force: true });
    ctx.log(`Removed ${paths.plist}`);
  }
  ctx.log(`Disabled LaunchAgent ${DARWIN_LABEL} (checkout and env file left in place)`);
  return 0;
}
