import {
  applyHostExecConfig,
  emptyHostInventory,
  EXEC_CONFIG_CAPABILITY,
  EXEC_CONFIG_REQUIRED_MESSAGE,
  parseHostUpdateConfig,
  principalHas,
} from "@auto-harness/shared";

import { mayAccessHost, mayAccessRepository } from "./auth-policy.ts";
import type { Principal } from "./auth.ts";
import { writeRouteAudit } from "./local-audit.ts";
import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";

function versionFrom(body: unknown): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as { version?: unknown }).version;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function permitted(ctx: RouteCtx): boolean {
  return !ctx.principal || principalHas(ctx.principal, EXEC_CONFIG_CAPABILITY);
}

function canAccessStoredRepositories(
  principal: Principal | undefined,
  repositories: readonly { id: string }[],
): boolean {
  return (
    !principal?.allowedRepositoryIds ||
    repositories.some((item) => mayAccessRepository(principal, item.id))
  );
}

function sendNotFound(res: RouteCtx["res"]): void {
  send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
}

function updateAudit(hostId: string, outcome?: "denied" | "failed", changed = false) {
  return {
    action: "host-update-config:update",
    resourceType: "host-inventory",
    resourceId: hostId,
    ...(outcome ? { outcome } : {}),
    ...(!outcome || changed ? { metadata: { changed: ["updateConfig"] } } : {}),
  } as const;
}

async function auditOrHandleFailure(
  ctx: RouteCtx,
  hostId: string,
  outcome?: "denied" | "failed",
  changed = false,
): Promise<boolean> {
  return !(await writeRouteAudit(ctx, updateAudit(hostId, outcome, changed)));
}

/** Host-scoped signed-update settings, protected like other executable configuration. */
export async function handleHostUpdateConfigRoutes(ctx: RouteCtx): Promise<boolean> {
  const { res, url, method } = ctx;
  const match = /^\/api\/v1\/hosts\/([^/]+)\/update-config$/.exec(url.pathname);
  if (!match) return false;
  const hostId = decodeURIComponent(match[1]!);
  if (!mayAccessHost(ctx.principal, hostId)) {
    if (await auditOrHandleFailure(ctx, hostId, "denied")) return true;
    sendNotFound(res);
    return true;
  }
  if (method === "GET") return await getHostUpdateConfig(ctx, hostId);
  if (method !== "PUT") return false;
  return await putHostUpdateConfig(ctx, hostId);
}

async function getHostUpdateConfig(ctx: RouteCtx, hostId: string): Promise<true> {
  try {
    const config = await ctx.plane.getHostInventoryDurable(hostId);
    if (!config || !canAccessStoredRepositories(ctx.principal, config.repositories)) {
      sendNotFound(ctx.res);
      return true;
    }
    send(ctx.res, 200, { updateConfig: config.updateConfig, version: config.version });
  } catch {
    sendInternalError(ctx.res);
  }
  return true;
}

async function readUpdateBody(ctx: RouteCtx): Promise<unknown | undefined> {
  let body: unknown;
  try {
    body = await readJson(ctx.req);
  } catch {
    send(ctx.res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
    return undefined;
  }
  return body;
}

async function putHostUpdateConfig(ctx: RouteCtx, hostId: string): Promise<true> {
  const body = await readUpdateBody(ctx);
  if (body === undefined) return true;
  try {
    const stored = await ctx.plane.getHostInventoryDurable(hostId);
    const existing = stored ?? emptyHostInventory();
    if (!canAccessStoredRepositories(ctx.principal, existing.repositories)) {
      sendNotFound(ctx.res);
      return true;
    }
    if (!permitted(ctx)) {
      if (await auditOrHandleFailure(ctx, hostId, "denied")) return true;
      send(ctx.res, 403, { error: { code: "FORBIDDEN", message: EXEC_CONFIG_REQUIRED_MESSAGE } });
      return true;
    }
    if (!body || typeof body !== "object" || !Object.hasOwn(body, "updateConfig")) {
      throw new TypeError("updateConfig is required");
    }
    const updateConfig = parseHostUpdateConfig((body as { updateConfig: unknown }).updateConfig);
    const version = versionFrom(body) ?? stored?.version ?? 0;
    if (await auditOrHandleFailure(ctx, hostId)) return true;
    const result = await ctx.plane.putHostInventoryDurable(
      hostId,
      { ...applyHostExecConfig(existing, { updateConfig }), version },
      { allowLegacyRelativeTerminalHooks: true, awaitProjection: false },
    );
    if (!result.ok) {
      await sendPutFailure(ctx, hostId, ctx.res, result);
      return true;
    }
    send(ctx.res, 200, {
      updateConfig: result.config.updateConfig,
      version: result.config.version,
    });
    return true;
  } catch (error) {
    await sendUpdateError(ctx, hostId, ctx.res, error);
    return true;
  }
}

async function sendPutFailure(
  ctx: RouteCtx,
  hostId: string,
  res: RouteCtx["res"],
  result: { conflict?: boolean; error: string },
): Promise<void> {
  if (await auditOrHandleFailure(ctx, hostId, "failed", true)) return;
  send(res, result.conflict ? 409 : 400, {
    error: {
      code: result.conflict ? "CONFLICT" : "VALIDATION_ERROR",
      message: result.error,
    },
  });
}

async function sendUpdateError(
  ctx: RouteCtx,
  hostId: string,
  res: RouteCtx["res"],
  error: unknown,
): Promise<void> {
  if (await auditOrHandleFailure(ctx, hostId, "failed")) return;
  if (error instanceof TypeError) {
    send(res, 400, { error: { code: "VALIDATION_ERROR", message: error.message } });
  } else {
    sendInternalError(res);
  }
}
