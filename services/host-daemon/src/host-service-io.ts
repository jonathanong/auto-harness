import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type HostServiceFs = {
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, opts: { recursive: boolean; mode: number }) => void;
  writeFileSync: (path: string, data: string, opts: { mode: number }) => void;
  readFileSync: (path: string) => string;
  chmodSync: (path: string, mode: number) => void;
  rmSync: (path: string, opts: { force: boolean }) => void;
};

export type HostServiceRunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type HostServiceRun = (command: string, args: string[]) => HostServiceRunResult;

export type HostServiceOpts = {
  env: NodeJS.ProcessEnv;
  log: (msg: string) => void;
  error: (msg: string) => void;
  platform?: string;
  fs?: HostServiceFs;
  run?: HostServiceRun;
  checkoutRoot?: string;
  nodePath?: string;
  home?: string;
  appData?: string;
  tmpDir?: string;
  uid?: number;
};

export type HostServiceContext = {
  env: NodeJS.ProcessEnv;
  log: (msg: string) => void;
  error: (msg: string) => void;
  platform: string;
  fs: HostServiceFs;
  run: HostServiceRun;
  checkoutRoot: string;
  nodePath: string;
  home: string;
  appData: string;
  tmpDir: string;
  uid: number;
  envExamplePath: string;
  unitTemplatePath: string;
  launcherPath: string;
};

export const nodeHostServiceFs: HostServiceFs = {
  existsSync,
  mkdirSync: (path, opts) => {
    mkdirSync(path, opts);
  },
  writeFileSync: (path, data, opts) => {
    writeFileSync(path, data, { encoding: "utf8", mode: opts.mode });
  },
  readFileSync: (path) => readFileSync(path, "utf8"),
  chmodSync,
  rmSync: (path, opts) => {
    rmSync(path, opts);
  },
};

export function spawnStatus(status: number | null): number {
  return status ?? 1;
}

export function resolveHome(
  optsHome: string | undefined,
  env: NodeJS.ProcessEnv,
  fallback: () => string,
): string {
  return optsHome ?? env.HOME ?? env.USERPROFILE ?? fallback();
}

export function resolveUid(
  optsUid: number | undefined,
  getuid: (() => number) | undefined,
): number {
  return optsUid ?? getuid?.() ?? 1;
}

export function defaultHostServiceRun(command: string, args: string[]): HostServiceRunResult {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false });
  if (result.error) {
    return { status: 1, stdout: "", stderr: result.error.message };
  }
  return {
    status: spawnStatus(result.status),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function defaultCheckoutRoot(): string {
  return fileURLToPath(new URL("../../..", import.meta.url));
}

export function writeMode(fs: HostServiceFs, path: string, data: string, mode: number): void {
  fs.writeFileSync(path, data, { mode });
  fs.chmodSync(path, mode);
}

export function failedCommand(
  error: (msg: string) => void,
  label: string,
  result: HostServiceRunResult,
): 1 {
  error(
    `${label} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`,
  );
  return 1;
}

export function resolveHostService(opts: HostServiceOpts): HostServiceContext {
  const env = opts.env;
  const checkoutRoot = opts.checkoutRoot ?? defaultCheckoutRoot();
  const home = resolveHome(opts.home, env, homedir);
  return {
    env,
    log: opts.log,
    error: opts.error,
    platform: opts.platform ?? process.platform,
    fs: opts.fs ?? nodeHostServiceFs,
    run: opts.run ?? defaultHostServiceRun,
    checkoutRoot,
    nodePath: opts.nodePath ?? process.execPath,
    home,
    appData: opts.appData ?? env.APPDATA ?? join(home, "AppData", "Roaming"),
    tmpDir: opts.tmpDir ?? tmpdir(),
    uid: resolveUid(opts.uid, process.getuid),
    envExamplePath: join(checkoutRoot, "services/host-daemon/systemd/host-daemon.env.example"),
    unitTemplatePath: join(
      checkoutRoot,
      "services/host-daemon/systemd/auto-harness-host-daemon.service",
    ),
    launcherPath: join(checkoutRoot, "services/host-daemon/bin/auto-harness-host-daemon.mjs"),
  };
}
