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

function extraKeys(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((key) => key.trim())
    .filter(
      (key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !key.toUpperCase().startsWith("HARNESS_"),
    );
}

/**
 * Return the intentionally small child environment.  Extra variables must be
 * explicitly named in HARNESS_CHILD_ENV_ALLOWLIST; HARNESS_* is always owned
 * by the daemon and is never inherited by untrusted child processes.
 */
export function createChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = new Set([...BASELINE_KEYS, ...extraKeys(source.HARNESS_CHILD_ENV_ALLOWLIST)]);
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
