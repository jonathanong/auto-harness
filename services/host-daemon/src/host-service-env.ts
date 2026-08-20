import { LOCAL_API_HTTP, LOCAL_HOST_ID } from "@auto-harness/shared";

function allowlistedExtras(env: NodeJS.ProcessEnv): string[] {
  const raw = env.HARNESS_CHILD_ENV_ALLOWLIST;
  if (!raw) return [];
  return raw
    .split(",")
    .map((key) => key.trim())
    .filter(
      (key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !key.toUpperCase().startsWith("HARNESS_"),
    );
}

export function parseEnvFile(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq);
    let value = line.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
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
    if (out[key] === undefined || out[key] === "") {
      out[key] = value;
    }
  }
  return out;
}

export function pathFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH ?? env.Path;
}

function isPlaceholder(value: string): boolean {
  return value.length === 0 || /REPLACE_WITH/i.test(value);
}

/** Gaps that would persist local/placeholder identity into a new env file. */
export function envIdentityErrors(env: NodeJS.ProcessEnv, platform: string): string[] {
  const hostId = env.HARNESS_HOST_ID?.trim() ?? "";
  const apiUrl = env.HARNESS_API_URL?.trim() || env.HARNESS_API_HTTP?.trim() || "";
  const apiKey = env.HARNESS_API_KEY?.trim() ?? "";
  const errors: string[] = [];
  if (isPlaceholder(hostId) || (platform === "linux" && hostId === LOCAL_HOST_ID)) {
    errors.push("HARNESS_HOST_ID");
  }
  if (isPlaceholder(apiUrl) || (platform === "linux" && apiUrl === LOCAL_API_HTTP)) {
    errors.push("HARNESS_API_URL");
  }
  if (isPlaceholder(apiKey)) {
    errors.push("HARNESS_API_KEY");
  }
  return errors;
}

export function warnOrRefuseIdentity(opts: {
  env: NodeJS.ProcessEnv;
  platform: string;
  error: (msg: string) => void;
  log: (msg: string) => void;
}): number {
  const gaps = envIdentityErrors(opts.env, opts.platform);
  if (gaps.length === 0) return 0;
  const detail = `set ${gaps.join(", ")} to real bound values (not placeholders or local defaults)`;
  if (opts.platform === "linux") {
    opts.error(`Refusing to write a new env file: ${detail}`);
    return 1;
  }
  opts.log(`Warning: ${detail}`);
  return 0;
}

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
 * Render a systemd-style env file from the checked-in example, filling current
 * identity. Extra allowlisted child credentials are appended so they survive
 * restart; HARNESS_* still never reaches repository commands.
 */
export function renderEnvFile(
  example: string,
  env: NodeJS.ProcessEnv,
  opts: { capturePath?: boolean } = {},
): string {
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
    out.push(`${key}=${value}`);
  }
  for (const key of allowlistedExtras(env)) {
    const value = env[key];
    if (value === undefined || seen.has(key)) continue;
    assertSingleLine(key, value);
    seen.add(key);
    out.push(`${key}=${value}`);
  }
  const rendered = out.join("\n");
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}
