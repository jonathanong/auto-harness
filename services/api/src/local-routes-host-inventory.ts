import { readJson, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { mayAccessHost, mayAccessRepository } from "./auth-policy.ts";

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
    try {
      const result = await plane.putHostInventoryDurable(hostId, body);
      if (!result.ok) {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: result.error },
        });
        return true;
      }
      const config = result.config;
      send(res, 200, {
        ...config,
        repositories: config.repositories.filter((repository) =>
          mayAccessRepository(ctx.principal, repository.id),
        ),
      });
      return true;
    } catch {
      sendInternalError(res);
      return true;
    }
  }

  if (method === "DELETE") {
    try {
      const result = await plane.deleteHostInventoryDurable(hostId);
      if (!result.ok) {
        send(res, 404, {
          error: { code: "NOT_FOUND", message: result.error },
        });
        return true;
      }
      send(res, 204, null);
      return true;
    } catch {
      sendInternalError(res);
      return true;
    }
  }

  return false;
}
