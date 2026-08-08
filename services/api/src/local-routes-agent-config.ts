import { readJson, send, type RouteCtx } from "./local-http.ts";

/**
 * Agent host inventory routes (paths + command profile argv).
 * Configured via API/UI; agent fetches on start (env identity only).
 */
export async function handleAgentConfigRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, req, res, url, method } = ctx;

  if (method === "GET" && url.pathname === "/api/v1/agent-hosts") {
    send(res, 200, { items: plane.listAgentHostConfigs() });
    return true;
  }

  const match = /^\/api\/v1\/agents\/([^/]+)\/config$/.exec(url.pathname);
  if (!match) {
    return false;
  }
  const hostId = decodeURIComponent(match[1]!);

  if (method === "GET") {
    const config = plane.getAgentHostConfig(hostId);
    if (!config) {
      send(res, 404, {
        error: { code: "NOT_FOUND", message: `no host config for agent ${hostId}` },
      });
      return true;
    }
    send(res, 200, config);
    return true;
  }

  if (method === "PUT") {
    try {
      const body = await readJson(req);
      const result = plane.putAgentHostConfig(hostId, body);
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
    const result = plane.deleteAgentHostConfig(hostId);
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
