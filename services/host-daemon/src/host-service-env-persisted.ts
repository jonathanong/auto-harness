import {
  renderEnvFile,
  isProductionApiUrl,
  PERSISTED_DAEMON_ENV_KEYS,
  validatePersistedEnvFile,
} from "./host-service-env.ts";
import { parseChildEnvAllowlist } from "./child-env.ts";

function assertSingleLine(key: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${key} must be a single line`);
}

function updatePersistedDaemonEnv(contents: string, env: NodeJS.ProcessEnv): string {
  const updates = new Map<string, string>();
  for (const key of PERSISTED_DAEMON_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== "") updates.set(key, value);
  }
  if (updates.size === 0) return contents;
  const seen = new Set<string>();
  const lines = contents.split(/\r?\n/).map((line) => {
    const eq = line.indexOf("=");
    if (eq <= 0 || line.trim().startsWith("#")) return line;
    const key = line.slice(0, eq).trim();
    const value = updates.get(key);
    if (value === undefined) return line;
    assertSingleLine(key, value);
    seen.add(key);
    return `${line.slice(0, eq + 1)}${value}`;
  });
  for (const [key, value] of updates) {
    if (seen.has(key)) continue;
    assertSingleLine(key, value);
    if (lines.at(-1) === "") lines.pop();
    lines.push(`${key}=${value}`);
  }
  const rendered = lines.join("\n");
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

export function serviceEnv(env: NodeJS.ProcessEnv, apiUrl: string | undefined): NodeJS.ProcessEnv {
  return apiUrl === undefined ? env : { ...env, HARNESS_API_URL: apiUrl };
}

export function updatePersistedApiUrl(contents: string, apiUrl: string): string {
  const lines = contents.split(/\r?\n/);
  let found = false;
  const updated = lines.map((line) => {
    const eq = line.indexOf("=");
    if (eq < 0 || line.slice(0, eq).trim() !== "HARNESS_API_URL") return line;
    found = true;
    return `${line.slice(0, eq + 1)}${apiUrl}`;
  });
  if (!found) {
    if (updated.at(-1) === "") updated.pop();
    updated.push(`HARNESS_API_URL=${apiUrl}`);
  }
  const result = updated.join("\n");
  return result.endsWith("\n") ? result : `${result}\n`;
}

export function preparePersistedEnv(opts: {
  existing: string | undefined;
  example: string;
  env: NodeJS.ProcessEnv;
  apiUrl?: string | undefined;
  capturePath?: boolean | undefined;
}): { contents: string; errors: string[] } {
  if (opts.apiUrl !== undefined && !isProductionApiUrl(opts.apiUrl)) {
    const errors =
      opts.existing === undefined ? ["HARNESS_API_URL"] : validatePersistedEnvFile(opts.existing);
    if (!errors.includes("HARNESS_API_URL")) errors.push("HARNESS_API_URL");
    return { contents: opts.existing ?? "", errors };
  }
  let contents: string;
  if (opts.existing === undefined) {
    const env = serviceEnv(opts.env, opts.apiUrl);
    const childEnvErrors = parseChildEnvAllowlist(env).errors;
    if (childEnvErrors.length > 0) return { contents: "", errors: childEnvErrors };
    contents =
      opts.capturePath === undefined
        ? renderEnvFile(opts.example, env)
        : renderEnvFile(opts.example, env, { capturePath: opts.capturePath });
  } else if (opts.apiUrl === undefined) {
    contents = opts.existing;
  } else {
    contents = updatePersistedApiUrl(opts.existing, opts.apiUrl);
  }
  contents = updatePersistedDaemonEnv(contents, opts.env);
  const errors = validatePersistedEnvFile(contents);
  // Keep an existing valid service file intact when a new relative profile
  // path is rejected. Callers already avoid writes on errors, and returning
  // the original contents makes that no-write guarantee explicit to them.
  if (errors.includes("HARNESS_EXECUTION_PROFILES")) {
    return { contents: opts.existing ?? "", errors };
  }
  return { contents, errors };
}
