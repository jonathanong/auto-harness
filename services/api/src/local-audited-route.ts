import { mayAccessRepository } from "./auth-policy.ts";
import { writeRouteAudit, type RouteAudit } from "./local-audit.ts";
import { readJson, send, type RouteCtx } from "./local-http.ts";

/** Documented JSON/error envelope used by mutation routes. */
export function sendRouteError(
  res: RouteCtx["res"],
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  send(res, status, { error: { code, message, ...extra } });
}

export function sendHiddenNotFound(res: RouteCtx["res"]): void {
  sendRouteError(res, 404, "NOT_FOUND", "resource not found");
}

export async function readJsonBody(
  ctx: RouteCtx,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await readJson(ctx.req) };
  } catch {
    sendRouteError(ctx.res, 400, "VALIDATION_ERROR", "invalid JSON body");
    return { ok: false };
  }
}

export async function readJsonBodyWithAudit(
  ctx: RouteCtx,
  audit: RouteAudit,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await readJson(ctx.req) };
  } catch {
    if (!(await writeRouteAudit(ctx, { ...audit, outcome: "failed" }))) return { ok: false };
    sendRouteError(ctx.res, 400, "VALIDATION_ERROR", "invalid JSON body");
    return { ok: false };
  }
}

export function repositoryInScope(ctx: RouteCtx, repositoryId: string | undefined): boolean {
  return !ctx.principal || mayAccessRepository(ctx.principal, repositoryId);
}

/** Hide out-of-scope repositories the same way as missing ones. */
export function denyRepositoryScope(ctx: RouteCtx): void {
  sendHiddenNotFound(ctx.res);
}

/** Couple a mutation to its audit row; false means the handler already sent 500. */
export function commitMutationAudit(ctx: RouteCtx, event: RouteAudit): Promise<boolean> {
  return writeRouteAudit(ctx, event);
}
