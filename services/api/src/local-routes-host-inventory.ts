/* eslint-disable max-lines -- scoped PUT merge shares the inventory route module. */
import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { mayAccessHost, mayAccessRepository } from "./auth-policy.ts";
import type { Principal } from "./auth.ts";
import { writeRouteAudit } from "./local-audit.ts";
import {
  EXEC_CONFIG_CAPABILITY,
  EXEC_CONFIG_REQUIRED_MESSAGE,
  inventoryHasExecConfig,
  parseHostInventory,
  principalHas,
  reconcileInventoryWrite,
  type HostInventory,
} from "@auto-harness/shared";

/** Preserve repos a scoped caller cannot see so a filtered GET+PUT cannot wipe them. */
export function mergeHiddenRepositories(
  existing: HostInventory | null,
  incoming: { repositories: unknown[] },
  principal: Principal | undefined,
): void {
  if (!principal?.allowedRepositoryIds || !existing) return;
  const hidden = existing.repositories.filter(
    (repository) => !mayAccessRepository(principal, repository.id),
  );
  incoming.repositories = [...hidden, ...incoming.repositories];
}

/**
 * Host inventory routes (paths + command profile argv).
 * Configured via API/UI; daemon fetches on start (env identity only).
 */
export async function handleHostInventoryRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/host-inventories") {
    try {
      send(res, 200, {
        items: (await plane.listHostInventoriesDurable())
          .filter((inventory) => mayAccessHost(ctx.principal, inventory.hostId))
          .map((inventory) => ({
            ...inventory,
            repositories: inventory.repositories.filter(
              (repository) => !ctx.principal || mayAccessRepository(ctx.principal, repository.id),
            ),
          }))
          .filter(
            (inventory) =>
              inventory.repositories.length > 0 || !ctx.principal?.allowedRepositoryIds,
          ),
      });
    } catch {
      sendInternalError(res);
    }
    return true;
  }

  const match = /^\/api\/v1\/hosts\/([^/]+)\/inventory$/.exec(url.pathname);
  if (!match) {
    return false;
  }
  const hostId = decodeURIComponent(match[1]!);

  if (!mayAccessHost(ctx.principal, hostId)) {
    if (
      !(await writeRouteAudit(ctx, {
        action: `host-inventory:${method === "DELETE" ? "delete" : "update"}`,
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
      if (!config) {
        send(res, 404, {
          error: { code: "NOT_FOUND", message: `no host inventory for host ${hostId}` },
        });
        return true;
      }
      const repositories = config.repositories.filter(
        (repository) => !ctx.principal || mayAccessRepository(ctx.principal, repository.id),
      );
      if (repositories.length === 0 && ctx.principal?.allowedRepositoryIds) {
        send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
        return true;
      }
      send(res, 200, { ...config, repositories });
    } catch {
      sendInternalError(res);
    }
    return true;
  }

  if (method === "PUT") {
    let body: unknown;
    try {
      body = await readJson(req);
      if (
        ctx.principal?.allowedRepositoryIds &&
        (!body ||
          typeof body !== "object" ||
          !Array.isArray((body as { repositories?: unknown }).repositories) ||
          !(body as { repositories: Array<{ id?: unknown }> }).repositories.every(
            (repository) =>
              typeof repository.id === "string" &&
              mayAccessRepository(ctx.principal, repository.id),
          ))
      ) {
        send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
        return true;
      }
    } catch {
      send(res, 400, {
        error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
      });
      return true;
    }
    let execEdits: string[] = [];
    let execAuditWritten = false;
    try {
      const incoming =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as { repositories?: unknown[]; version?: unknown })
          : undefined;
      const existing = await plane.getHostInventoryDurable(hostId);
      if (Array.isArray(incoming?.repositories)) {
        mergeHiddenRepositories(existing, incoming as { repositories: unknown[] }, ctx.principal);
      }
      try {
        const reconciled = reconcileInventoryWrite({
          existing,
          incoming: parseHostInventory(body, { allowLegacyRelativeTerminalHooks: true }),
          allowExecConfig: !ctx.principal || principalHas(ctx.principal, EXEC_CONFIG_CAPABILITY),
        });
        if (!reconciled.ok) {
          if (reconciled.kind === "forbidden") {
            if (
              !(await writeRouteAudit(ctx, {
                action: "host-exec-config:update",
                resourceType: "host-inventory",
                resourceId: hostId,
                outcome: "denied",
                metadata: { changed: reconciled.execEdits },
              }))
            )
              return true;
            send(res, 403, {
              error: { code: "FORBIDDEN", message: reconciled.error },
            });
            return true;
          }
          if (
            !(await writeRouteAudit(ctx, {
              action: "host-inventory:update",
              resourceType: "host-inventory",
              resourceId: hostId,
              outcome: "failed",
            }))
          )
            return true;
          send(res, 400, {
            error: { code: "VALIDATION_ERROR", message: reconciled.error },
          });
          return true;
        }
        execEdits = reconciled.execEdits;
        const version =
          typeof incoming?.version === "number" && Number.isInteger(incoming.version)
            ? incoming.version
            : (existing?.version ?? 0);
        body = {
          ...reconciled.inventory,
          version,
        };
      } catch {
        // Invalid inventory is reported by putHostInventoryDurable.
      }
      if (execEdits.length) {
        // A successful privileged audit must exist before an executable configuration can
        // commit. Audit storage failure therefore leaves the inventory unchanged.
        if (
          !(await writeRouteAudit(ctx, {
            action: "host-exec-config:update",
            resourceType: "host-inventory",
            resourceId: hostId,
            metadata: { changed: execEdits },
          }))
        )
          return true;
        execAuditWritten = true;
      }
      const result = await plane.putHostInventoryDurable(hostId, body, {
        allowLegacyRelativeTerminalHooks: true,
      });
      if (!result.ok) {
        if (
          execAuditWritten &&
          !(await writeRouteAudit(ctx, {
            action: "host-exec-config:update",
            resourceType: "host-inventory",
            resourceId: hostId,
            outcome: "failed",
            metadata: { changed: execEdits },
          }))
        )
          return true;
        if (
          !(await writeRouteAudit(ctx, {
            action: "host-inventory:update",
            resourceType: "host-inventory",
            resourceId: hostId,
            outcome: "failed",
          }))
        )
          return true;
        // A conflict is not a bad request: the body was valid, the document simply moved
        // since the caller read it. Callers re-read and reapply.
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
          action: "host-inventory:update",
          resourceType: "host-inventory",
          resourceId: hostId,
          metadata: { repositories: result.config.repositories.map((repository) => repository.id) },
        }))
      )
        return true;
      const config = result.config;
      send(res, 200, {
        ...config,
        repositories: config.repositories.filter((repository) =>
          mayAccessRepository(ctx.principal, repository.id),
        ),
      });
      return true;
    } catch {
      if (
        execAuditWritten &&
        !(await writeRouteAudit(ctx, {
          action: "host-exec-config:update",
          resourceType: "host-inventory",
          resourceId: hostId,
          outcome: "failed",
          metadata: { changed: execEdits },
        }))
      )
        return true;
      if (
        !(await writeRouteAudit(ctx, {
          action: "host-inventory:update",
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

  if (method === "DELETE") {
    if (ctx.principal?.allowedRepositoryIds?.length) {
      if (
        !(await writeRouteAudit(ctx, {
          action: "host-inventory:delete",
          resourceType: "host-inventory",
          resourceId: hostId,
          outcome: "denied",
        }))
      )
        return true;
      send(res, 404, { error: { code: "NOT_FOUND", message: "resource not found" } });
      return true;
    }
    try {
      const existing = await plane.getHostInventoryDurable(hostId);
      if (
        inventoryHasExecConfig(existing) &&
        ctx.principal &&
        !principalHas(ctx.principal, EXEC_CONFIG_CAPABILITY)
      ) {
        if (
          !(await writeRouteAudit(ctx, {
            action: "host-inventory:delete",
            resourceType: "host-inventory",
            resourceId: hostId,
            outcome: "denied",
          }))
        )
          return true;
        send(res, 403, {
          error: { code: "FORBIDDEN", message: EXEC_CONFIG_REQUIRED_MESSAGE },
        });
        return true;
      }
      const result = await plane.deleteHostInventoryDurable(hostId, existing?.version ?? 0);
      if (!result.ok) {
        if (
          !(await writeRouteAudit(ctx, {
            action: "host-inventory:delete",
            resourceType: "host-inventory",
            resourceId: hostId,
            outcome: "failed",
          }))
        )
          return true;
        send(res, result.conflict ? 409 : 404, {
          error: {
            code: result.conflict ? "CONFLICT" : "NOT_FOUND",
            message: result.error,
          },
        });
        return true;
      }
      if (
        !(await writeRouteAudit(ctx, {
          action: "host-inventory:delete",
          resourceType: "host-inventory",
          resourceId: hostId,
        }))
      )
        return true;
      send(res, 204, null);
      return true;
    } catch {
      if (
        !(await writeRouteAudit(ctx, {
          action: "host-inventory:delete",
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

  return false;
}
