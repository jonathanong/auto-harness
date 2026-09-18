import { AutoHarnessClient } from "../index.js";
import { checkAdminLoginUsage, loginAsAdmin } from "./admin-login.js";
import { CliConfigError } from "./cli-errors.js";

export const GLOBAL_VALUE_FLAGS = ["--api-url", "--api-key-file", "--admin-username"];
export const GLOBAL_BOOLEAN_FLAGS = ["--allow-insecure-http", "--admin-password-stdin"];

/** A flag that is present wins, even with an empty value — `--api-url=` or
 * `--api-key-file "$UNSET"` is an explicit choice that went wrong, not an absent flag. Falling
 * back to the environment would silently use a different URL, or authenticate as a different
 * principal, than the one the command line asked for. So an empty value is a config error. */
function explicitFlag(flags, name) {
  if (!Object.hasOwn(flags, name)) return undefined;
  if (flags[name].trim() === "") throw new CliConfigError(`${name} was given an empty value`);
  return flags[name];
}

/** `--api-url`, else `HARNESS_API_URL`, else `HARNESS_API_HTTP` (the host daemon's own alias —
 * operators already have one of these two set). Missing entirely is a config error naming both. */
export function resolveApiUrl(flags, env) {
  const url = explicitFlag(flags, "--api-url") ?? (env.HARNESS_API_URL || env.HARNESS_API_HTTP);
  if (!url) {
    throw new CliConfigError(
      "no API base URL configured: set --api-url, or the HARNESS_API_URL environment " +
        "variable (alias: HARNESS_API_HTTP)",
    );
  }
  return url;
}

/**
 * Precedence: an explicit `--api-key-file` flag wins outright — it is the most specific,
 * most intentional signal an operator can give on any one invocation. Failing that, the direct
 * `HARNESS_API_KEY` value wins over the indirect `HARNESS_API_KEY_FILE` pointer, since a plain
 * env var is one less level of indirection to reason about. Any consistent order satisfies the
 * spec here; this one mirrors "flag beats env" from `resolveApiUrl` above.
 */
export async function resolveApiKey(flags, env, readFile) {
  const keyFile = explicitFlag(flags, "--api-key-file");
  if (keyFile !== undefined) return readApiKeyFile(keyFile, readFile);
  if (env.HARNESS_API_KEY) return env.HARNESS_API_KEY.trim();
  if (env.HARNESS_API_KEY_FILE) return readApiKeyFile(env.HARNESS_API_KEY_FILE, readFile);
  return undefined;
}

async function readApiKeyFile(path, readFile) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new CliConfigError(`could not read API key file ${path}: ${error.message}`);
  }
  const trimmed = contents.trim();
  if (!trimmed) throw new CliConfigError(`API key file ${path} is empty`);
  return trimmed;
}

/**
 * `--admin-password-stdin` replaces the whole apiKey identity with an admin username/password
 * login, so its usage checks run here — unconditionally, for every command — before either an
 * apiKey is resolved or (in `createClient`) the login request is made.
 */
export async function resolveConfig(flags, io) {
  const baseUrl = resolveApiUrl(flags, io.env);
  checkAdminLoginUsage(flags, io.env);
  const allowInsecureHttp = Boolean(flags["--allow-insecure-http"]);
  if (flags["--admin-password-stdin"]) {
    const adminUsername = flags["--admin-username"] || "admin";
    return { baseUrl, allowInsecureHttp, adminMode: true, adminUsername };
  }
  const apiKey = await resolveApiKey(flags, io.env, io.readFile);
  return { baseUrl, apiKey, allowInsecureHttp };
}

/** Builds the real `AutoHarnessClient`; a constructor rejection (e.g. plaintext http with an
 * apiKey set against a non-loopback host) is a configuration problem, not an API failure, so it
 * is re-thrown as `CliConfigError` (exit 2) rather than surfacing as a generic exit-1 error. A
 * failed admin login (a bad password, an unreachable server) is deliberately *not* wrapped this
 * way — it is reported as a plain error (exit 1), matching a rejected API key rather than a
 * usage/config problem. */
export async function createClient(flags, io) {
  const config = await resolveConfig(flags, io);
  const fetchFn = config.adminMode
    ? (await loginAsAdmin(io, config.baseUrl, config.adminUsername, config.allowInsecureHttp)).fetch
    : io.fetch;
  try {
    return new AutoHarnessClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      fetch: fetchFn,
      allowInsecureHttp: config.allowInsecureHttp,
    });
  } catch (error) {
    throw new CliConfigError(error.message);
  }
}
