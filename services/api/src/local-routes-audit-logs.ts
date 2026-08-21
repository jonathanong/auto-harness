import { principalHas } from "@auto-harness/shared";

import type { AuditOutcome } from "./audit-types.ts";
import { send, sendInternalError, type RouteCtx } from "./local-http.ts";

const OUTCOMES: AuditOutcome[] = ["success", "denied", "failed"];

function optionalQuery(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value && value.length <= 256 ? value : undefined;
}

/** Admin-only immutable audit history. There is intentionally no write route. */
export async function handleAuditLogRoutes(ctx: RouteCtx): Promise<boolean> {
  const { method, url, res, plane } = ctx;
  if (method !== "GET" || url.pathname !== "/api/v1/audit-logs") return false;
  if (!ctx.principal || !principalHas(ctx.principal, "audit:read")) {
    send(res, 403, { error: { code: "FORBIDDEN", message: "admin access required" } });
    return true;
  }
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  const rawOutcome = url.searchParams.get("outcome");
  if (
    (rawLimit !== null && (!Number.isInteger(limit) || limit! < 1 || limit! > 100)) ||
    (rawOutcome !== null && !OUTCOMES.includes(rawOutcome as AuditOutcome))
  ) {
    send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid audit query" } });
    return true;
  }
  try {
    const page = await plane.listAuditLogs({
      ...(limit !== undefined ? { limit } : {}),
      ...(optionalQuery(url, "cursor") ? { cursor: optionalQuery(url, "cursor") } : {}),
      ...(optionalQuery(url, "actorId") ? { actorId: optionalQuery(url, "actorId") } : {}),
      ...(optionalQuery(url, "action") ? { action: optionalQuery(url, "action") } : {}),
      ...(optionalQuery(url, "resourceType")
        ? { resourceType: optionalQuery(url, "resourceType") }
        : {}),
      ...(optionalQuery(url, "resourceId") ? { resourceId: optionalQuery(url, "resourceId") } : {}),
      ...(optionalQuery(url, "repositoryId")
        ? { repositoryId: optionalQuery(url, "repositoryId") }
        : {}),
      ...(rawOutcome !== null ? { outcome: rawOutcome as AuditOutcome } : {}),
    });
    send(res, 200, page);
  } catch {
    sendInternalError(res);
  }
  return true;
}
