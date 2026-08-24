import {
  applyHostExecConfig,
  emptyHostInventory,
  EXEC_CONFIG_CAPABILITY,
  EXEC_CONFIG_REQUIRED_MESSAGE,
  listExecConfigEdits,
  parseHostExecConfig,
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

function allowsExecConfig(ctx: RouteCtx): boolean {
  return !ctx.principal || principalHas(ctx.principal, EXEC_CONFIG_CAPABILITY);
}

/** Admin-only setup scripts, terminal hook paths, and host-local allowed roots. */
export async function handleHostExecConfigRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;
  const match = /^\/api\/v1\/hosts\/([^/]+)\/exec-config$/.exec(url.pathname);
  if (!match) return false;
  const hostId = decodeURIComponent(match[1]!);

  if (!mayAccessHost(ctx.principal, hostId)) {
    if (
      !(await writeRouteAudit(ctx, {
        action: "host-exec-config:update",
        resourceType: "host-inventory",
        resourceId: hostId,
        outcome: "denied",
      }))
    )
      return true;
    send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
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
    if (!allowsExecConfig(ctx)) {
      if (
        !(await writeRouteAudit(ctx, {
          action: "host-exec-config:update",
          resourceType: "host-inventory",
          resourceId: hostId,
          outcome: "denied",
        }))
      )
        return true;
      send(res, 403, {
        error: {
          code: "FORBIDDEN",
          message: EXEC_CONFIG_REQUIRED_MESSAGE,
        },
      });
      return true;
    }
    let patch;
    let merged;
    try {
      patch = parseHostExecConfig(body);
      merged = applyHostExecConfig(existing, patch);
    } catch (error) {
      if (
        !(await writeRouteAudit(ctx, {
          action: "host-exec-config:update",
          resourceType: "host-inventory",
          resourceId: hostId,
          outcome: "failed",
        }))
      )
        return true;
      send(res, 400, {
        error: {
          code: "VALIDATION_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return true;
    }
    // Versionless patches are still fenced: the server has just read this exact document.
    const version = versionFrom(body) ?? stored?.version ?? 0;
    const changed = listExecConfigEdits(existing, merged);
    // Audit first: a failed success-audit must not publish exec-config.
    if (
      !(await writeRouteAudit(ctx, {
        action: "host-exec-config:update",
        resourceType: "host-inventory",
        resourceId: hostId,
        metadata: { changed },
      }))
    )
      return true;
    const result = await plane.putHostInventoryDurable(
      hostId,
      {
        ...merged,
        version,
      },
      {
        // applyHostExecConfig can carry an untouched pre-policy relative hook forward.
        // New values are still rejected by parseHostExecConfig.
        allowLegacyRelativeTerminalHooks: true,
      },
    );
    if (!result.ok) {
      if (
        !(await writeRouteAudit(ctx, {
          action: "host-exec-config:update",
          resourceType: "host-inventory",
          resourceId: hostId,
          outcome: "failed",
          metadata: { changed },
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
    const config = result.config;
    send(res, 200, {
      setupScript: config.setupScript,
      allowedRoots: config.allowedRoots,
      repositories: config.repositories
        .filter((repository) => mayAccessRepository(ctx.principal, repository.id))
        .map((repository) => ({
          id: repository.id,
          setupScript: repository.setupScript,
          terminalHookScript: repository.terminalHookScript,
          worktrees: repository.worktrees.map((worktree) => ({
            id: worktree.id,
            setupScript: worktree.setupScript,
          })),
        })),
      version: config.version,
    });
    return true;
  } catch {
    if (
      !(await writeRouteAudit(ctx, {
        action: "host-exec-config:update",
        resourceType: "host-inventory",
        resourceId: hostId,
        outcome: "failed",
      }))
    )
      return true;
    sendInternalError(res);
    return true;
  }
}
