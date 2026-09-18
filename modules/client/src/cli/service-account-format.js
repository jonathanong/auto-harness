import { allowlistPrincipal } from "./allowlist.js";

/**
 * `allowlistPrincipal` plus `createdAt`. `GET /auth/service-accounts` items (and the `account`
 * returned by `POST /auth/service-accounts`) are already server-sanitized (`publicPrincipal`)
 * plus `name`/`createdAt`, but this is printed through the same allowlist as `whoami`/`doctor`
 * as defense in depth — `createdAt` is added back on top since it is not part of a bare
 * principal and so is not in `ALLOWED_PRINCIPAL_FIELDS`.
 */
export function allowlistAccount(account) {
  const allowed = allowlistPrincipal(account);
  if (account && typeof account === "object" && Object.hasOwn(account, "createdAt")) {
    allowed.createdAt = account.createdAt;
  }
  return allowed;
}

/** One-line human summary: id, name, role, and (when present) boundHostId/createdAt. */
export function formatAccountLine(account) {
  const parts = [account.id, account.name, account.role];
  if (account.boundHostId) parts.push(account.boundHostId);
  if (account.createdAt) parts.push(account.createdAt);
  return parts.join("  ");
}
