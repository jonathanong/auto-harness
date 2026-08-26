import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Look up an environment variable, optionally tolerating the OS-native
 * casing Windows reports for names like `Path`/`Pathext` — `NodeJS.ProcessEnv`
 * property access is case-sensitive even when the underlying env var isn't.
 */
function envValue(
  env: NodeJS.ProcessEnv,
  name: string,
  caseInsensitive: boolean,
): string | undefined {
  if (env[name] !== undefined) return env[name];
  if (!caseInsensitive) return undefined;
  const target = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === target) return env[key];
  }
  return undefined;
}

// A directory can pass an X_OK / existence check (a searchable directory is
// "accessible") without being a file at all. A PATH entry earlier than the
// real binary's directory could contain a same-named directory (e.g. a
// checked-out ref's build output), which would otherwise be wrongly returned
// instead of continuing the search.
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutablePosix(path: string): boolean {
  if (!isRegularFile(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

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
  // A bare command name never contains a path separator by definition — one
  // that does is attempting to escape whichever PATH directory it's joined
  // against (e.g. "..\\..\\untrusted\\evil"). An already-absolute path is
  // handled above and passes through unchanged, so rejecting this doesn't
  // remove any legitimate capability, only an invariant a bare name must
  // already satisfy.
  if (/[/\\]/.test(command)) {
    throw new Error(`Cannot resolve trusted executable "${command}": contains a path separator`);
  }

  const isWindows = platform === "win32";
  const directories = (envValue(env, "PATH", isWindows) ?? "")
    .split(isWindows ? ";" : ":")
    .filter((directory) => directory.length > 0)
    // A relative PATH entry resolves against whichever process happens to be
    // spawned with it as argv[0] and *that* process's cwd — for a session
    // daemon that cwd is the untrusted checkout, so a relative entry could
    // reintroduce the exact cwd-search vulnerability this function exists to
    // close. Only absolute directories are trustworthy search roots.
    .filter((directory) => isAbsolute(directory));
  const extensions = isWindows
    ? (envValue(env, "PATHEXT", true) ?? DEFAULT_PATHEXT)
        .split(";")
        .filter((ext) => ext.length > 0)
        .map((ext) => ext.toLowerCase())
    : [""];
  const lowerCommand = command.toLowerCase();
  const hasExplicitExtension = /\.[^./\\]+$/.test(command);

  for (const directory of directories) {
    if (isWindows) {
      // Probe the command's own extension first, independent of PATHEXT: a
      // custom PATHEXT that happens to omit e.g. ".EXE" must not make an
      // already-fully-qualified filename like "cmd.exe" unresolvable.
      if (hasExplicitExtension) {
        const explicit = join(directory, command);
        if (isRegularFile(explicit)) return explicit;
      }
      for (const extension of extensions) {
        if (extension && lowerCommand.endsWith(extension)) continue;
        const candidate = join(directory, `${command}${extension}`);
        if (isRegularFile(candidate)) return candidate;
      }
    } else {
      const candidate = join(directory, command);
      if (isExecutablePosix(candidate)) return candidate;
    }
  }
  throw new Error(`Cannot resolve trusted executable "${command}": not found on PATH`);
}
