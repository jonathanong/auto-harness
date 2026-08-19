/**
 * Refuse a non-loopback UI bind unless production-shaped auth is configured.
 * Usage: node scripts/validate-bind.mts HARNESS_WEB_HOST
 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.trim() || "127.0.0.1");
}

export function validateBindHost(
  envName: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; error: string } {
  const host = (env[envName] ?? "127.0.0.1").trim() || "127.0.0.1";
  if (isLoopbackHost(host)) return { ok: true };
  const mode = env.HARNESS_AUTH_MODE ?? "";
  const secret = env.HARNESS_SESSION_SECRET ?? "";
  const admins = env.HARNESS_ADMINS ?? "";
  if (mode === "required" && secret.length >= 32 && admins.length > 0) return { ok: true };
  return {
    ok: false,
    error: `non-loopback ${envName}=${host} requires HARNESS_AUTH_MODE=required, HARNESS_SESSION_SECRET (>=32 chars), and HARNESS_ADMINS`,
  };
}

const invokedAsCli = (process.argv[1] ?? "").includes("validate-bind.mts");
if (invokedAsCli) {
  const name = process.argv[2];
  if (!name) {
    console.error("usage: validate-bind.mts ENV_VAR_NAME");
    process.exit(2);
  }
  const result = validateBindHost(name);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
}
