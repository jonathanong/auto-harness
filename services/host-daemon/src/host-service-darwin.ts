import { join } from "node:path";

import { pathFromEnv, renderEnvFile } from "./host-service-env.ts";
import type { HostServiceContext } from "./host-service-io.ts";
import { failedCommand, writeMode } from "./host-service-io.ts";
import { DARWIN_LABEL, renderLaunchAgentPlist } from "./host-service-templates.ts";

function darwinPaths(home: string): {
  plist: string;
  envFile: string;
  log: string;
  agentsDir: string;
  supportDir: string;
} {
  return {
    plist: join(home, "Library/LaunchAgents/com.auto-harness.host-daemon.plist"),
    envFile: join(home, "Library/Application Support/auto-harness/host-daemon.env"),
    log: join(home, "Library/Logs/auto-harness-host-daemon.log"),
    agentsDir: join(home, "Library/LaunchAgents"),
    supportDir: join(home, "Library/Application Support/auto-harness"),
  };
}

function launchDomain(uid: number): string {
  return `gui/${uid}`;
}

export function installDarwin(ctx: HostServiceContext): number {
  const paths = darwinPaths(ctx.home);
  ctx.fs.mkdirSync(paths.agentsDir, { recursive: true, mode: 0o755 });
  ctx.fs.mkdirSync(paths.supportDir, { recursive: true, mode: 0o755 });
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
    paths.plist,
    renderLaunchAgentPlist({
      nodePath: ctx.nodePath,
      launcherPath: ctx.launcherPath,
      checkoutRoot: ctx.checkoutRoot,
      home: ctx.home,
      envFilePath: paths.envFile,
      pathValue: pathFromEnv(ctx.env) ?? "/usr/local/bin:/usr/bin:/bin",
      logPath: paths.log,
    }),
    0o644,
  );
  ctx.log(`Wrote ${paths.plist}`);
  const domain = launchDomain(ctx.uid);
  ctx.run("launchctl", ["bootout", `${domain}/${DARWIN_LABEL}`]);
  const boot = ctx.run("launchctl", ["bootstrap", domain, paths.plist]);
  if (boot.status !== 0) {
    const load = ctx.run("launchctl", ["load", "-w", paths.plist]);
    if (load.status !== 0) return failedCommand(ctx.error, "launchctl bootstrap/load", load);
  } else {
    const kick = ctx.run("launchctl", ["kickstart", "-k", `${domain}/${DARWIN_LABEL}`]);
    if (kick.status !== 0) return failedCommand(ctx.error, "launchctl kickstart", kick);
  }
  ctx.log(`Enabled LaunchAgent ${DARWIN_LABEL} as the current user`);
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
