import { readJson, send, type RouteCtx } from "./local-http.ts";
import { mayAccessHost, mayAccessRepository } from "./auth-policy.ts";

/**
 * Host inventory routes (paths + command profile argv).
 * Configured via API/UI; daemon fetches on start (env identity only).
 */
export async function handleHostInventoryRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/host-inventories") {
    send(res, 200, {
      items: plane
        .listHostInventories()
        .filter((inventory) => mayAccessHost(ctx.principal, inventory.hostId))
        .map((inventory) => ({
          ...inventory,
          repositories: inventory.repositories.filter(
            (repository) => !ctx.principal || mayAccessRepository(ctx.principal, repository.id),
          ),
        }))
        .filter(
          (inventory) => inventory.repositories.length > 0 || !ctx.principal?.allowedRepositoryIds,
        ),
    });
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
    const config = plane.getHostInventory(hostId);
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
    return true;
  }

  if (method === "PUT") {
    try {
      const body = await readJson(req);
      const result = plane.putHostInventory(hostId, body);
      if (!result.ok) {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: result.error },
        });
        return true;
      }
      send(res, 200, result.config);
      return true;
    } catch {
      send(res, 400, {
        error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
      });
      return true;
    }
  }

  if (method === "DELETE") {
    const result = plane.deleteHostInventory(hostId);
    if (!result.ok) {
      send(res, 404, {
        error: { code: "NOT_FOUND", message: result.error },
      });
      return true;
    }
    send(res, 204, null);
    return true;
  }

  return false;
}
