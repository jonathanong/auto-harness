import { assignQueuedDurable } from "./control-plane-assign.ts";
import { writeRouteAudit } from "./local-audit.ts";
import { send, sendInternalError, type RouteCtx } from "./local-http.ts";

export async function handleProviderAccountUsageRoute(ctx: RouteCtx): Promise<boolean> {
  const { plane, res, url, method } = ctx;
  const match = /^\/api\/v1\/provider-accounts\/([^/]+)\/usage-limit$/.exec(url.pathname);
  if (method !== "DELETE" || !match) return false;
  const id = match[1]!;
  let result: Awaited<ReturnType<typeof plane.clearProviderAccountUsageLimitDurable>>;
  try {
    result = await plane.clearProviderAccountUsageLimitDurable(id);
  } catch {
    if (
      !(await writeRouteAudit(ctx, {
        action: "provider-account:clear-usage-limit",
        resourceType: "provider-account",
        resourceId: id,
        outcome: "failed",
      }))
    )
      return true;
    sendInternalError(res);
    return true;
  }
  if (!result.ok) {
    if (
      !(await writeRouteAudit(ctx, {
        action: "provider-account:clear-usage-limit",
        resourceType: "provider-account",
        resourceId: id,
        outcome: "failed",
      }))
    )
      return true;
    send(res, result.conflict ? 409 : 404, {
      error: { code: result.conflict ? "CONFLICT" : "NOT_FOUND", message: result.error },
    });
    return true;
  }
  await assignQueuedDurable(plane.state);
  if (
    !(await writeRouteAudit(ctx, {
      action: "provider-account:clear-usage-limit",
      resourceType: "provider-account",
      resourceId: result.account.id,
    }))
  )
    return true;
  send(res, 200, result.account);
  return true;
}
