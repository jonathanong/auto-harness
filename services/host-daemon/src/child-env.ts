/**
 * Environment passed to repository-owned processes.  The daemon itself needs
 * control-plane credentials, but a command or hook does not: forwarding the
 * whole daemon environment would make those credentials available to arbitrary
 * repository code.
 */
const BASELINE_KEYS = new Set([
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
]);

function isBaselineKey(key: string): boolean {
  return BASELINE_KEYS.has(key) || key.startsWith("LC_");
}

export function parseChildEnvAllowlist(source: NodeJS.ProcessEnv): {
  keys: string[];
  errors: string[];
} {
  const raw = source.HARNESS_CHILD_ENV_ALLOWLIST;
  if (!raw) return { keys: [], errors: [] };
  const keys: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [index, rawKey] of raw.split(",").entries()) {
    const key = rawKey.trim();
    if (!key) {
      errors.push(`HARNESS_CHILD_ENV_ALLOWLIST has an empty entry at position ${index + 1}`);
    } else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      // Do not echo malformed input: a mistaken NAME=value entry may contain a secret.
      errors.push(`HARNESS_CHILD_ENV_ALLOWLIST invalid name at position ${index + 1}`);
    } else if (key.toUpperCase().startsWith("HARNESS_")) {
      errors.push(`HARNESS_CHILD_ENV_ALLOWLIST reserved name: ${key}`);
    } else if (seen.has(key)) {
      errors.push(`HARNESS_CHILD_ENV_ALLOWLIST duplicate name: ${key}`);
    } else if (!Object.hasOwn(source, key) || typeof source[key] !== "string") {
      errors.push(`HARNESS_CHILD_ENV_ALLOWLIST undefined name: ${key}`);
      seen.add(key);
    } else {
      seen.add(key);
      keys.push(key);
    }
  }
  return { keys, errors };
}

/**
 * Return the intentionally small child environment.  Extra variables must be
 * explicitly named in HARNESS_CHILD_ENV_ALLOWLIST; HARNESS_* is always owned
 * by the daemon and is never inherited by untrusted child processes.
 */
export function createChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const extras = parseChildEnvAllowlist(source);
  if (extras.errors.length > 0) throw new Error(extras.errors.join("; "));
  const env: NodeJS.ProcessEnv = {};
  const allowed = new Set([...BASELINE_KEYS, ...extras.keys]);
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      !key.toUpperCase().startsWith("HARNESS_") &&
      (isBaselineKey(key) || allowed.has(key))
    ) {
      env[key] = value;
    }
  }
  return env;
}
