/**
 * Refuse a non-loopback UI bind unless authentication is actually configured.
 *
 * `services/api` enforces this inline before it listens (local-server.ts), but the two
 * Next.js apps have no equivalent hook, so their `dev`/`start` scripts shell out here
 * first. The contract is the one documented in docs/auth.md: the local API and both local
 * UIs bind to 127.0.0.1 by default, and an explicit host is honoured only when
 * HARNESS_AUTH_MODE, HARNESS_SESSION_SECRET, and HARNESS_ADMINS are all set.
 */

/** Matches services/api/src/local-server.ts's isLoopback. */
export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export const MIN_SESSION_SECRET_LENGTH = 32;

/**
 * Returns the reason the bind must be refused, or null when it is allowed.
 * Kept pure so the policy is testable without spawning a Next.js server.
 */
export function validateBind(
  hostVariable: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const host = env[hostVariable]?.trim();
  if (!host || isLoopback(host)) return null;

  const missing: string[] = [];
  if (env.HARNESS_AUTH_MODE !== "required") missing.push("HARNESS_AUTH_MODE=required");
  if ((env.HARNESS_SESSION_SECRET?.length ?? 0) < MIN_SESSION_SECRET_LENGTH) {
    missing.push(`HARNESS_SESSION_SECRET (at least ${MIN_SESSION_SECRET_LENGTH} characters)`);
  }
  if (!env.HARNESS_ADMINS?.trim()) missing.push("HARNESS_ADMINS");
  if (missing.length === 0) return null;

  return [
    `Refusing to bind ${hostVariable}=${host} to a non-loopback address.`,
    `Missing: ${missing.join(", ")}.`,
    `Unset ${hostVariable} to bind 127.0.0.1, or see docs/auth.md#local-authentication-and-public-binds.`,
  ].join("\n");
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly || process.argv[1]?.endsWith("validate-bind.mts")) {
  const hostVariable = process.argv[2];
  if (!hostVariable) {
    console.error("usage: validate-bind.mts <HOST_ENV_VAR>");
    process.exit(2);
  }
  const refusal = validateBind(hostVariable);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
}
