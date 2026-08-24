import {
  applyHostExecConfig,
  emptyHostInventory,
  EXEC_CONFIG_CAPABILITY,
  EXEC_CONFIG_REQUIRED_MESSAGE,
  parseHostUpdateConfig,
  principalHas,
} from "@auto-harness/shared";

import { mayAccessHost, mayAccessRepository } from "./auth-policy.ts";
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

/** Host-scoped signed-update settings, protected like other executable configuration. */
export async function handleHostUpdateConfigRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;
  const match = /^\/api\/v1\/hosts\/([^/]+)\/update-config$/.exec(url.pathname);
  if (!match) return false;
  const hostId = decodeURIComponent(match[1]!);
  if (!mayAccessHost(ctx.principal, hostId)) {
    if (
      !(await writeRouteAudit(ctx, {
        action: "host-update-config:update",
        resourceType: "host-inventory",
        resourceId: hostId,
        outcome: "denied",
      }))
    )
      return true;
    send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
    return true;
  }
  if (method === "GET") {
    try {
      const config = await plane.getHostInventoryDurable(hostId);
      if (
        !config ||
        (ctx.principal?.allowedRepositoryIds &&
          !config.repositories.some((repository) =>
            mayAccessRepository(ctx.principal, repository.id),
          ))
      ) {
        send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
        return true;
      }
      send(res, 200, { updateConfig: config.updateConfig, version: config.version });
    } catch {
      sendInternalError(res);
    }
    return true;
  }
  if (method !== "PUT") return false;
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    send(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
    return true;
  }
  try {
    const stored = await plane.getHostInventoryDurable(hostId);
    const existing = stored ?? emptyHostInventory();
    if (
      ctx.principal?.allowedRepositoryIds &&
      !existing.repositories.some((repository) => mayAccessRepository(ctx.principal, repository.id))
    ) {
      send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
      return true;
    }
    if (!permitted(ctx)) {
      if (
        !(await writeRouteAudit(ctx, {
          action: "host-update-config:update",
          resourceType: "host-inventory",
          resourceId: hostId,
          outcome: "denied",
        }))
      )
        return true;
      send(res, 403, { error: { code: "FORBIDDEN", message: EXEC_CONFIG_REQUIRED_MESSAGE } });
      return true;
    }
    if (!body || typeof body !== "object" || !Object.hasOwn(body, "updateConfig")) {
      throw new TypeError("updateConfig is required");
    }
    const updateConfig = parseHostUpdateConfig((body as { updateConfig: unknown }).updateConfig);
    const version = versionFrom(body) ?? stored?.version ?? 0;
    if (
      !(await writeRouteAudit(ctx, {
        action: "host-update-config:update",
        resourceType: "host-inventory",
        resourceId: hostId,
        metadata: { changed: ["updateConfig"] },
      }))
    )
      return true;
    const result = await plane.putHostInventoryDurable(
      hostId,
      { ...applyHostExecConfig(existing, { updateConfig }), version },
      { allowLegacyRelativeTerminalHooks: true, awaitProjection: false },
    );
    if (!result.ok) {
      if (
        !(await writeRouteAudit(ctx, {
          action: "host-update-config:update",
          resourceType: "host-inventory",
          resourceId: hostId,
          outcome: "failed",
          metadata: { changed: ["updateConfig"] },
        }))
      )
        return true;
      send(res, result.conflict ? 409 : 400, {
        error: {
          code: result.conflict ? "CONFLICT" : "VALIDATION_ERROR",
          message: result.error,
        },
      });
      return true;
    }
    send(res, 200, { updateConfig: result.config.updateConfig, version: result.config.version });
    return true;
  } catch (error) {
    if (
      !(await writeRouteAudit(ctx, {
        action: "host-update-config:update",
        resourceType: "host-inventory",
        resourceId: hostId,
        outcome: "failed",
      }))
    )
      return true;
    if (error instanceof TypeError) {
      send(res, 400, { error: { code: "VALIDATION_ERROR", message: error.message } });
    } else {
      sendInternalError(res);
    }
    return true;
  }
}
