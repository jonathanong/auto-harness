import {
  applyHostExecConfig,
  emptyHostInventory,
  EXEC_CONFIG_CAPABILITY,
  EXEC_CONFIG_REQUIRED_MESSAGE,
  listExecConfigEdits,
  parseHostExecConfig,
  principalHas,
  type HostInventory,
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

/** Best-effort undo after a successful write whose success audit could not be persisted. */
async function restoreInventory(
  plane: RouteCtx["plane"],
  hostId: string,
  previous: HostInventory | null,
  version: number | undefined,
): Promise<void> {
  try {
    if (!previous) {
      await plane.deleteHostInventoryDurable(hostId);
      return;
    }
    await plane.putHostInventoryDurable(hostId, {
      ...previous,
      ...(version !== undefined ? { version } : {}),
    });
  } catch {
    // Handler already failed closed; a crash between write and undo can still publish.
  }
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
    const version = versionFrom(body);
    const result = await plane.putHostInventoryDurable(hostId, {
      ...merged,
      ...(version !== undefined ? { version } : {}),
    });
    if (!result.ok) {
      if (
        !(await writeRouteAudit(ctx, {
          action: "host-exec-config:update",
          resourceType: "host-inventory",
          resourceId: hostId,
          outcome: "failed",
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
    if (
      !(await writeRouteAudit(ctx, {
        action: "host-exec-config:update",
        resourceType: "host-inventory",
        resourceId: hostId,
        metadata: { changed: listExecConfigEdits(existing, merged) },
      }))
    ) {
      await restoreInventory(plane, hostId, stored, result.config.version);
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
