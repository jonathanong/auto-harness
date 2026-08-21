import { join } from "node:path";

import { pathFromEnv, renderEnvFile, warnOrRefuseIdentity } from "./host-service-env.ts";
import type { HostServiceContext, HostServiceStatus } from "./host-service-io.ts";
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

export function statusDarwin(ctx: HostServiceContext): HostServiceStatus {
  const result = ctx.run("launchctl", ["print", `${launchDomain(ctx.uid)}/${DARWIN_LABEL}`]);
  if (result.status !== 0) {
    const output = `${result.stderr} ${result.stdout}`.toLowerCase();
    return /could not find|not found|no such service/.test(output)
      ? { state: "missing", reason: "launch agent is not installed" }
      : { state: "failed", reason: "launchctl status command failed" };
  }
  const state = /^\s*state\s*=\s*(\S+)/m.exec(result.stdout)?.[1]?.toLowerCase();
  if (state === "running") return { state: "running", reason: "launch agent is running" };
  if (state === "stopped" || state === "waiting") {
    return { state: "stopped", reason: `launch agent is ${state}` };
  }
  return { state: "unknown", reason: "launchctl returned an unrecognized state" };
}

export function installDarwin(ctx: HostServiceContext): number {
  const paths = darwinPaths(ctx.home);
  ctx.fs.mkdirSync(paths.agentsDir, { recursive: true, mode: 0o755 });
  ctx.fs.mkdirSync(paths.supportDir, { recursive: true, mode: 0o755 });
  if (ctx.fs.existsSync(paths.envFile)) {
    ctx.log(`Keeping existing env file ${paths.envFile}`);
  } else {
    warnOrRefuseIdentity(ctx);
    writeMode(
      ctx.fs,
      paths.envFile,
      renderEnvFile(ctx.fs.readFileSync(ctx.envExamplePath), ctx.env),
      0o600,
      true,
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
