/* eslint-disable max-lines -- service-environment parsing and persistence validation share one contract. */
import { isPositiveAssignmentCap, LOCAL_API_HTTP, LOCAL_HOST_ID } from "@auto-harness/shared";
import { isAbsolute, win32 } from "node:path";
import { parseChildEnvAllowlist } from "./child-env.ts";

export function parseEnvFile(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq);
    let value = line.slice(eq + 1);
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replaceAll("\\\\", "\\").replaceAll('\\"', '"');
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

export function loadEnvFileIfPresent(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): NodeJS.ProcessEnv {
  const envFile = env.HARNESS_ENV_FILE?.trim();
  if (!envFile) return env;
  return applyEnvFile(readFile(envFile), env);
}

/** Fill missing keys from an env file; existing non-empty values win. */
export function applyEnvFile(contents: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(parseEnvFile(contents))) {
    // An explicitly blank updater value disables an already-persisted update
    // configuration. Other historical identity fields retain their existing
    // "empty means load the env file" behavior.
    if (out[key] === undefined || (out[key] === "" && !UPDATER_ENV_KEYS.has(key))) {
      out[key] = value;
    }
  }
  return out;
}

export function pathFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH ?? env.Path;
}

function isPlaceholder(value: string): boolean {
  return (
    value.length === 0 ||
    /^(?:REPLACE_WITH|PLACEHOLDER|YOUR[_ -]|<[^>]+>|\$\{[^}]+\})/iu.test(value)
  );
}

/**
 * Service files outlive the installer process, so their profile-file value
 * cannot depend on the installer or supervisor working directory. Recognize
 * both native and Windows absolute paths because platform service fixtures are
 * exercised from one host OS.
 */
function isPersistableExecutionProfilesPath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function isInvalidAssignmentCap(value: string | undefined): boolean {
  return value !== undefined && value !== "" && !isPositiveAssignmentCap(Number(value));
}

export function isProductionApiUrl(value: string): boolean {
  if (/[\r\n]/u.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "127" ||
    hostname.startsWith("127.") ||
    hostname === "0.0.0.0" ||
    hostname === "::1"
  ) {
    return false;
  }
  return !/\.execute-api\.[^.]+\.amazonaws\.com$/u.test(hostname);
}

/** Gaps that would persist local/placeholder identity into a service env file. */
export function envIdentityErrors(env: NodeJS.ProcessEnv, _platform: string): string[] {
  const hostId = env.HARNESS_HOST_ID?.trim() ?? "";
  const apiUrl = env.HARNESS_API_URL?.trim() || env.HARNESS_API_HTTP?.trim() || "";
  const apiKey = env.HARNESS_API_KEY?.trim() ?? "";
  const errors: string[] = [];
  if (isPlaceholder(hostId) || hostId === LOCAL_HOST_ID) errors.push("HARNESS_HOST_ID");
  if (isPlaceholder(apiUrl) || !isProductionApiUrl(apiUrl)) {
    errors.push("HARNESS_API_URL");
  }
  if (isPlaceholder(apiKey)) {
    errors.push("HARNESS_API_KEY");
  }
  return errors;
}

export function validatePersistedEnvFile(contents: string): string[] {
  const env = parseEnvFile(contents);
  const hostId = env.HARNESS_HOST_ID?.trim() ?? "";
  const apiUrl = env.HARNESS_API_URL?.trim() ?? "";
  const apiKey = env.HARNESS_API_KEY?.trim() ?? "";
  const errors: string[] = [];
  if (isPlaceholder(hostId) || hostId === LOCAL_HOST_ID) errors.push("HARNESS_HOST_ID");
  if (isPlaceholder(apiUrl) || !isProductionApiUrl(apiUrl)) errors.push("HARNESS_API_URL");
  if (isPlaceholder(apiKey)) errors.push("HARNESS_API_KEY");
  const executionProfiles = env.HARNESS_EXECUTION_PROFILES;
  if (
    executionProfiles !== undefined &&
    executionProfiles !== "" &&
    !isPersistableExecutionProfilesPath(executionProfiles)
  ) {
    errors.push("HARNESS_EXECUTION_PROFILES");
  }
  const maxConcurrentAssignments = env.HARNESS_MAX_CONCURRENT_ASSIGNMENTS;
  if (isInvalidAssignmentCap(maxConcurrentAssignments)) {
    errors.push("HARNESS_MAX_CONCURRENT_ASSIGNMENTS");
  }
  errors.push(...parseChildEnvAllowlist(env).errors);
  return errors;
}

export function persistedEnvError(errors: string[]): string {
  const remediation =
    "set each named variable to its real bound production value (HTTPS control-plane URL, bound host id, and bound service key)";
  const profilePathRemediation = errors.includes("HARNESS_EXECUTION_PROFILES")
    ? " HARNESS_EXECUTION_PROFILES must be an absolute path."
    : "";
  return `Refusing service install: invalid ${errors.join(", ")}; ${remediation}.${profilePathRemediation}`;
}

export const PERSISTED_DAEMON_ENV_KEYS = [
  "HARNESS_EXECUTION_PROFILES",
  "HARNESS_MAX_CONCURRENT_ASSIGNMENTS",
  "HARNESS_UPDATE_MANIFEST_URL",
  "HARNESS_UPDATE_PUBLIC_KEY",
  "HARNESS_UPDATE_INSTALL_DIR",
  "HARNESS_UPDATE_POLL_MS",
  "HARNESS_DAEMON_VERSION",
] as const;

const UPDATER_ENV_KEYS = new Set<string>([
  "HARNESS_UPDATE_MANIFEST_URL",
  "HARNESS_UPDATE_PUBLIC_KEY",
  "HARNESS_UPDATE_INSTALL_DIR",
  "HARNESS_UPDATE_POLL_MS",
  "HARNESS_DAEMON_VERSION",
]);

function filledValue(
  key: string,
  fallback: string,
  env: NodeJS.ProcessEnv,
  capturePath: boolean,
): string {
  if (key === "HARNESS_HOST_ID") {
    return env.HARNESS_HOST_ID?.trim() || LOCAL_HOST_ID;
  }
  if (key === "HARNESS_API_URL") {
    return env.HARNESS_API_URL?.trim() || env.HARNESS_API_HTTP?.trim() || LOCAL_API_HTTP;
  }
  if (key === "HARNESS_API_KEY") {
    return env.HARNESS_API_KEY ?? "";
  }
  if (key === "PATH") {
    return capturePath ? pathFromEnv(env) || fallback : fallback;
  }
  const value = env[key];
  return value !== undefined && value !== "" ? value : fallback;
}

function assertSingleLine(key: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${key} must be a single line`);
  }
}

/**
 * systemd EnvironmentFile consumes backslashes in unquoted values. Keep the
 * updater's documented literal `\\n` PEM encoding intact by quoting it and
 * escaping the backslash for the EnvironmentFile parser.
 */
export function formatPersistedEnvValue(key: string, value: string): string {
  if (key !== "HARNESS_UPDATE_PUBLIC_KEY" || value === "") return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Render a systemd-style env file from the checked-in example, filling current
 * identity. Extra allowlisted child credentials are appended so they survive
 * restart; HARNESS_* still never reaches repository commands.
 */
export function renderEnvFile(
  example: string,
  env: NodeJS.ProcessEnv,
  opts: { capturePath?: boolean } = {},
): string {
  const extras = parseChildEnvAllowlist(env);
  if (extras.errors.length > 0) throw new Error(extras.errors.join("; "));
  const capturePath = opts.capturePath !== false;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of example.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) {
      out.push(line);
      continue;
    }
    const eq = line.indexOf("=");
    const key = line.slice(0, eq);
    seen.add(key);
    const value = filledValue(key, line.slice(eq + 1), env, capturePath);
    assertSingleLine(key, value);
    out.push(`${key}=${formatPersistedEnvValue(key, value)}`);
  }
  for (const key of extras.keys) {
    const value = env[key];
    if (value === undefined || seen.has(key)) continue;
    assertSingleLine(key, value);
    seen.add(key);
    out.push(`${key}=${formatPersistedEnvValue(key, value)}`);
  }
  for (const key of PERSISTED_DAEMON_ENV_KEYS) {
    const value = env[key];
    if (value === undefined || value === "" || seen.has(key)) continue;
    assertSingleLine(key, value);
    seen.add(key);
    out.push(`${key}=${formatPersistedEnvValue(key, value)}`);
  }
  const rendered = out.join("\n");
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}
