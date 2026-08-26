/* eslint-disable max-lines -- provider-account CRUD and lease routes share one REST boundary. */
import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { writeRouteAudit } from "./local-audit.ts";
import { handleProviderAccountUsageRoute } from "./local-routes-provider-account-usage.ts";
import { MAX_CONCURRENT_SESSIONS_LIMIT } from "@auto-harness/shared";
import { mayAccessRepository } from "./auth-policy.ts";

/** Provider account CRUD routes. Returns true if handled. */
export async function handleProviderAccountRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/provider-accounts") {
    try {
      send(res, 200, { items: await plane.listProviderAccountsDurable() });
    } catch {
      sendInternalError(res);
    }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/v1/provider-accounts") {
    let body: Record<string, unknown>;
    try {
      body = (await readJson(req)) as Record<string, unknown>;
    } catch {
      send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
      return true;
    }
    try {
      const result = await plane.createProviderAccountDurable({
        providerId: String(body.providerId ?? ""),
        label: String(body.label ?? ""),
        ...(typeof body.usageLimitCooldownSeconds === "number"
          ? { usageLimitCooldownSeconds: body.usageLimitCooldownSeconds }
          : {}),
        ...(typeof body.maxConcurrentSessions === "number"
          ? { maxConcurrentSessions: body.maxConcurrentSessions }
          : {}),
      });
      if (!result.ok) {
        if (
          !(await writeRouteAudit(ctx, {
            action: "provider-account:create",
            resourceType: "provider-account",
            resourceId: "new",
            outcome: "failed",
          }))
        )
          return true;
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: result.error } });
        return true;
      }
      if (
        !(await writeRouteAudit(ctx, {
          action: "provider-account:create",
          resourceType: "provider-account",
          resourceId: result.account.id,
          metadata: { providerId: result.account.providerId },
        }))
      )
        return true;
      send(res, 201, result.account);
      return true;
    } catch {
      if (
        !(await writeRouteAudit(ctx, {
          action: "provider-account:create",
          resourceType: "provider-account",
          resourceId: "new",
          outcome: "failed",
        }))
      )
        return true;
      sendInternalError(res);
      return true;
    }
  }
  if (await handleProviderAccountUsageRoute(ctx)) return true;
  const leaseMatch = /^\/api\/v1\/provider-accounts\/([^/]+)\/leases(?:\/([^/]+)\/release)?$/.exec(
    url.pathname,
  );
  if (leaseMatch) {
    const id = leaseMatch[1]!;
    const rawSlot = leaseMatch[2];
    if (method === "GET" && rawSlot === undefined) {
      try {
        const result = await plane.listProviderAccountLeaseStatesDurable(id, (session) =>
          mayAccessRepository(ctx.principal, session?.repositoryId),
        );
        if (!result.ok) {
          send(res, 404, { error: { code: "NOT_FOUND", message: "provider account not found" } });
          return true;
        }
        send(res, 200, { items: result.items });
      } catch {
        sendInternalError(res);
      }
      return true;
    }
    if (method === "POST" && rawSlot !== undefined) {
      if (!/^(?:0|[1-9]\d*)$/.test(rawSlot)) {
        if (
          !(await writeRouteAudit(ctx, {
            action: "provider-account-lease:release",
            resourceType: "provider-account",
            resourceId: `${id}:${rawSlot}`,
            outcome: "failed",
          }))
        )
          return true;
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid lease slot" } });
        return true;
      }
      const slot = Number(rawSlot);
      if (slot >= MAX_CONCURRENT_SESSIONS_LIMIT) {
        if (
          !(await writeRouteAudit(ctx, {
            action: "provider-account-lease:release",
            resourceType: "provider-account",
            resourceId: `${id}:${rawSlot}`,
            outcome: "failed",
          }))
        )
          return true;
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid lease slot" } });
        return true;
      }
      try {
        const result = await plane.forceReleaseProviderAccountLeaseDurable(id, slot, (session) =>
          mayAccessRepository(ctx.principal, session?.repositoryId),
        );
        if (!result.ok) {
          if (
            !(await writeRouteAudit(ctx, {
              action: "provider-account-lease:release",
              resourceType: "provider-account",
              resourceId: `${id}:${String(slot)}`,
              outcome: "failed",
            }))
          )
            return true;
          send(res, result.reason === "not_found" ? 404 : 409, {
            error: {
              code: result.reason === "not_found" ? "NOT_FOUND" : "CONFLICT",
              message:
                result.reason === "not_found"
                  ? "provider account not found"
                  : "provider account lease cannot be released",
            },
          });
          return true;
        }
        if (
          !(await writeRouteAudit(ctx, {
            action: "provider-account-lease:release",
            resourceType: "provider-account",
            resourceId: `${id}:${String(slot)}`,
            metadata: { released: result.result.released, slot },
          }))
        )
          return true;
        if (result.result.released) {
          await plane.requestAssignment();
          const refreshed = await plane.listProviderAccountLeaseStatesDurable(id, (session) =>
            mayAccessRepository(ctx.principal, session?.repositoryId),
          );
          if (refreshed.ok) {
            result.result.after =
              refreshed.items.find((item) => item.slot === slot) ?? result.result.after;
          }
        }
        send(res, 200, result.result);
      } catch {
        if (
          !(await writeRouteAudit(ctx, {
            action: "provider-account-lease:release",
            resourceType: "provider-account",
            resourceId: `${id}:${String(slot)}`,
            outcome: "failed",
          }))
        )
          return true;
        sendInternalError(res);
      }
      return true;
    }
  }
  const match = /^\/api\/v1\/provider-accounts\/([^/]+)$/.exec(url.pathname);
  if (match) {
    const id = match[1]!;
    if (method === "GET") {
      try {
        const account = await plane.getProviderAccountDurable(id);
        if (!account) {
          send(res, 404, { error: { code: "NOT_FOUND", message: "provider account not found" } });
          return true;
        }
        send(res, 200, account);
      } catch {
        sendInternalError(res);
      }
      return true;
    }
    if (method === "PUT" || method === "PATCH") {
      let body: Record<string, unknown>;
      try {
        body = (await readJson(req)) as Record<string, unknown>;
      } catch {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
        return true;
      }
      try {
        const result = await plane.updateProviderAccountDurable(id, {
          ...(typeof body.providerId === "string" ? { providerId: body.providerId } : {}),
          ...(typeof body.label === "string" ? { label: body.label } : {}),
          ...(typeof body.usageLimitCooldownSeconds === "number"
            ? { usageLimitCooldownSeconds: body.usageLimitCooldownSeconds }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(body, "maxConcurrentSessions")
            ? { maxConcurrentSessions: body.maxConcurrentSessions as number }
            : {}),
        });
        if (!result.ok) {
          if (
            !(await writeRouteAudit(ctx, {
              action: "provider-account:update",
              resourceType: "provider-account",
              resourceId: id,
              outcome: "failed",
            }))
          )
            return true;
          const status = result.conflict ? 409 : plane.getProviderAccount(id) ? 400 : 404;
          const code =
            status === 409 ? "CONFLICT" : status === 400 ? "VALIDATION_ERROR" : "NOT_FOUND";
          send(res, status, { error: { code, message: result.error } });
          return true;
        }
        if (
          !(await writeRouteAudit(ctx, {
            action: "provider-account:update",
            resourceType: "provider-account",
            resourceId: result.account.id,
            metadata: { providerId: result.account.providerId },
          }))
        )
          return true;
        if (typeof body.maxConcurrentSessions === "number" || typeof body.providerId === "string")
          await plane.requestAssignment();
        send(res, 200, result.account);
        return true;
      } catch {
        if (
          !(await writeRouteAudit(ctx, {
            action: "provider-account:update",
            resourceType: "provider-account",
            resourceId: id,
            outcome: "failed",
          }))
        )
          return true;
        sendInternalError(res);
        return true;
      }
    }
    if (method === "DELETE") {
      try {
        const result = await plane.deleteProviderAccountDurable(id);
        if (!result.ok) {
          if (
            !(await writeRouteAudit(ctx, {
              action: "provider-account:delete",
              resourceType: "provider-account",
              resourceId: id,
              outcome: "failed",
            }))
          )
            return true;
          send(res, result.conflict ? 409 : 404, {
            error: {
              code: result.conflict ? "CONFLICT" : "NOT_FOUND",
              message: result.error,
              ...(result.dependencies ? { dependencies: result.dependencies } : {}),
            },
          });
          return true;
        }
        if (
          !(await writeRouteAudit(ctx, {
            action: "provider-account:delete",
            resourceType: "provider-account",
            resourceId: id,
          }))
        )
          return true;
        send(res, 204, null);
        return true;
      } catch {
        if (
          !(await writeRouteAudit(ctx, {
            action: "provider-account:delete",
            resourceType: "provider-account",
            resourceId: id,
            outcome: "failed",
          }))
        )
          return true;
        sendInternalError(res);
        return true;
      }
    }
  }
  return false;
}
