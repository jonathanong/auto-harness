import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Resolve a trusted command name (e.g. "git", "pnpm", "cmd.exe") to an
 * absolute path by searching only `env.PATH`, never the caller's working
 * directory.
 *
 * On Windows, libuv's own executable search (`search_path()` in
 * `src/win/process.c`, used by `child_process.spawn` even with
 * `shell: false`) checks the spawned process's `cwd` *before* `PATH` for a
 * bare command name. When `cwd` is an untrusted checkout, a same-named
 * `git.exe`/`pnpm.cmd` planted there would be resolved and executed instead
 * of the real trusted binary. Resolving to an absolute path here removes
 * `cwd` from the search entirely: an already-qualified path is executed
 * directly, with no search at all.
 *
 * `env` should be the actual environment the caller is about to spawn with
 * (not necessarily `process.env`): a trusted admin-configured setup script
 * can legitimately customize `PATH` before dependency installation runs, and
 * resolution must honor that, not a fixed system PATH.
 */
export function resolveTrustedExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  if (isAbsolute(command)) return command;

  const isWindows = platform === "win32";
  const directories = (env.PATH ?? "")
    .split(isWindows ? ";" : ":")
    .filter((directory) => directory.length > 0);
  const extensions = isWindows
    ? (env.PATHEXT ?? DEFAULT_PATHEXT)
        .split(";")
        .filter((ext) => ext.length > 0)
        .map((ext) => ext.toLowerCase())
    : [""];
  const lowerCommand = command.toLowerCase();

  for (const directory of directories) {
    for (const extension of extensions) {
      const filename =
        extension && lowerCommand.endsWith(extension) ? command : `${command}${extension}`;
      const candidate = join(directory, filename);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`Cannot resolve trusted executable "${command}": not found on PATH`);
}
