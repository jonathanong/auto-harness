import { createHmac } from "node:crypto";

import { awsArgs } from "./aws-cli.ts";
import type { DeploymentConfig } from "./deployment-config.ts";
import type { DeploymentDependencies } from "./deployment-support.ts";

/**
 * Deliberately short: this credential exists only to complete this one deploy step's
 * probes, and expires well before a leaked log line or hung process could matter.
 */
const TOKEN_TTL_SECONDS = 120;
const SESSION_COOKIE_NAME = "auto_harness_session";
// Same pattern deployment-support.ts's assertLoginRendered uses for the unauthenticated
// /login check: a healthy page emits no `NEXT_`-prefixed token at all (Next's own inline
// hydration payload is `__next_f`), so this stays a general digest match, not a fixed list.
const CONTROL_FLOW_DIGEST = /NEXT_[A-Z_]+/u;

function b64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * Mint an HS256 admin session JWT with exactly the claims services/api/src/auth.ts's
 * issueCookie() writes, minus the day-long Max-Age. `samePrincipalClaims()` there rejects
 * any claim key outside {id, username, role, kind, boundHostId, allowedRepositoryIds} --
 * an extra field makes the token unusable, not merely ignored -- and hasValidSession()
 * (modules/shared/src/session-cookie.ts) rejects an `audience` claim outright. `id` must be
 * exactly `admin:${username}`, the shape auth.ts's parseAdmins() assigns real admins.
 */
export function mintAdminSessionToken(
  username: string,
  secret: string,
  now: () => number = Date.now,
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    id: `admin:${username}`,
    username,
    role: "admin",
    kind: "admin",
    exp: Math.floor(now() / 1000) + TOKEN_TTL_SECONDS,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

/** Both bootstrap parameters are SecureStrings (bootstrap-secret-param.ts); both need decryption. */
async function readSecureSsmParameter(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
  name: string,
): Promise<string | null> {
  const result = await dependencies.query(
    "aws",
    awsArgs(config, [
      "ssm",
      "get-parameter",
      "--name",
      name,
      "--with-decryption",
      "--query",
      "Parameter.Value",
      "--output",
      "text",
    ]),
  );
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

/** The first admin's username only -- the paired password is never destructured or read. */
function firstAdminUsername(adminsBase64Json: string): string | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(adminsBase64Json, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!Array.isArray(decoded) || decoded.length === 0) return undefined;
  const first: unknown = decoded[0];
  if (typeof first !== "object" || first === null) return undefined;
  const { username } = first as { username?: unknown };
  return typeof username === "string" && username.length > 0 ? username : undefined;
}

/**
 * Mints the short-lived admin session for probeAuthenticatedDeployment, or returns null
 * (after logging why) when there is nothing to probe: auth is explicitly not required here,
 * or there is no admin to mint a session for. Neither is a deploy failure.
 *
 * Every AWS deploy hardcodes HARNESS_AUTH_MODE=required on the web and runtime Lambdas
 * (web-stack.ts, lambda-handlers.ts) -- this deploy script's own process env does not carry
 * it today, so an *unset* env must proceed, not skip, or this stage would silently never
 * run against a real deployment. Only an explicit non-required override skips.
 */
async function mintDeploySmokeSession(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (env.HARNESS_AUTH_MODE !== undefined && env.HARNESS_AUTH_MODE !== "required") {
    dependencies.log(
      "Authenticated smoke probe skipped: HARNESS_AUTH_MODE is explicitly not required.",
    );
    return null;
  }
  const adminsRaw = await readSecureSsmParameter(config, dependencies, config.adminsSsmParam);
  const username = adminsRaw ? firstAdminUsername(adminsRaw) : undefined;
  if (!username) {
    dependencies.log(
      `Authenticated smoke probe skipped: ${config.adminsSsmParam} has no usable admin.`,
    );
    return null;
  }
  const secret = await readSecureSsmParameter(config, dependencies, config.sessionSecretSsmParam);
  if (!secret) {
    dependencies.log(
      `Authenticated smoke probe skipped: unable to read ${config.sessionSecretSsmParam}.`,
    );
    return null;
  }
  return mintAdminSessionToken(username, secret);
}

/** THE probe: the 2026-09-16 outage's worst bug was 12 pages returning 200 while SSR failed. */
async function probeAuthenticatedPageRenders(
  dependencies: DeploymentDependencies,
  webUrl: string,
  cookieHeader: string,
): Promise<void> {
  // `redirect: "manual"`, matching smokeDeployment's own /login check: a redirect means
  // the session was rejected, and following it would hide that behind a 200 for whatever
  // page it lands on.
  const response = await dependencies.fetch(new URL("hosts", `${webUrl}/`), {
    headers: { cookie: cookieHeader },
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `authenticated /hosts page redirected (HTTP ${response.status}) instead of rendering`,
    );
  }
  if (!response.ok) {
    throw new Error(`authenticated /hosts page check failed with HTTP ${response.status}`);
  }
  const body = await response.text();
  if (!body.includes('data-pw="page-hosts"')) {
    throw new Error("authenticated /hosts page did not render its page-hosts content marker");
  }
  if (CONTROL_FLOW_DIGEST.test(body)) {
    throw new Error("authenticated /hosts page leaked a Next.js control-flow digest into its HTML");
  }
}

/** The exact route that 500'd when dynamodb:Scan was ungranted (#748). */
async function probeHostsApi(
  dependencies: DeploymentDependencies,
  webUrl: string,
  cookieHeader: string,
): Promise<void> {
  const response = await dependencies.fetch(new URL("api/v1/hosts", `${webUrl}/`), {
    headers: { cookie: cookieHeader },
  });
  if (!response.ok) throw new Error(`GET /api/v1/hosts failed with HTTP ${response.status}`);
  const body = (await response.json()) as { items?: unknown };
  if (!Array.isArray(body.items)) {
    throw new Error("GET /api/v1/hosts returned a 200 without an items array");
  }
}

/**
 * An unrouted write must 404, not 403 "insufficient role" (#763). No route handler runs --
 * nothing in fleet/session/host state changes -- but local-app.ts's auth gate does record
 * one denied-write audit entry and one consumed mutation-rate-limit unit for this admin,
 * the same as any authenticated write a real client sends to a route that does not exist.
 */
async function probeUnroutedWriteIsNotFound(
  dependencies: DeploymentDependencies,
  webUrl: string,
  cookieHeader: string,
): Promise<void> {
  const response = await dependencies.fetch(new URL("api/v1/frobnicate", `${webUrl}/`), {
    method: "POST",
    headers: { cookie: cookieHeader },
  });
  if (response.status !== 404) {
    throw new Error(`unrouted write returned HTTP ${response.status}, expected 404`);
  }
  const body = (await response.json()) as { error?: { code?: unknown } };
  if (body.error?.code !== "NOT_FOUND") {
    throw new Error("unrouted write 404 did not carry a NOT_FOUND envelope");
  }
}

/**
 * Runs authenticated-surface probes smokeDeployment's public checks cannot reach: every
 * bug that took production down on 2026-09-16 returned a good status code on
 * unauthenticated surface, so nothing caught it. Called from the same validate phase as
 * the existing health/login checks, before smokeDeployment's remaining config-propagation
 * writes (publish WebUrl to SSM, recycle runtime Lambdas) -- not because those writes are
 * unsafe against a broken deploy, but because nothing should mark this deploy healthy by
 * writing further state until this has vouched for it too.
 *
 * Throws on any probe failure, unlike reportOrphanedTablesAfterUpdate's warn-only orphan
 * report: an orphaned table is a leftover on an otherwise-healthy deploy, but a failed
 * authenticated probe means the application itself is not correctly serving real users --
 * exactly the class this exists to catch -- so it fails the deploy the same way the
 * existing unauthenticated health/login checks already do.
 */
export async function probeAuthenticatedDeployment(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
  webUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const token = await mintDeploySmokeSession(config, dependencies, env);
  if (!token) return;
  const cookieHeader = `${SESSION_COOKIE_NAME}=${token}`;
  await probeAuthenticatedPageRenders(dependencies, webUrl, cookieHeader);
  await probeHostsApi(dependencies, webUrl, cookieHeader);
  await probeUnroutedWriteIsNotFound(dependencies, webUrl, cookieHeader);
  dependencies.log(`Authenticated smoke probes passed: ${webUrl}`);
}
