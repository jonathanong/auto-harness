import { readdirSync } from "node:fs";

export type FdCountDeps = {
  readdirSync?: typeof readdirSync;
  platform?: NodeJS.Platform;
};

/**
 * Best-effort count of this process's open file descriptors. Linux exposes
 * `/proc/self/fd`; macOS and other BSDs expose the equivalent `/dev/fd`.
 * Windows has no comparable directory listing, and any read failure (a
 * sandboxed environment, an unsupported OS) is swallowed -- this is a
 * liveness-log nicety, never something worth failing the daemon over.
 */
export function countOpenFds(deps: FdCountDeps = {}): number | undefined {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return undefined;
  const readdir = deps.readdirSync ?? readdirSync;
  const path = platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  try {
    return readdir(path).length;
  } catch {
    return undefined;
  }
}
