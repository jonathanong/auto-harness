import { send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { readJsonBody, sendHiddenNotFound, sendRouteError } from "./local-audited-route.ts";
import { writeRouteAudit } from "./local-audit.ts";
import type { WorkspacePoolInput } from "./control-plane-workspace-pools.ts";

function auditPoolMutation(ctx: RouteCtx, action: string, resourceId: string): Promise<boolean> {
  return writeRouteAudit(ctx, { action, resourceType: "workspace-pool", resourceId });
}

function poolInput(
  body: Record<string, unknown>,
  requireName: boolean,
):
  | { ok: true; input: WorkspacePoolInput | Partial<Omit<WorkspacePoolInput, "id">> }
  | { ok: false; error: string } {
  if (Object.hasOwn(body, "name") && typeof body.name !== "string") {
    return { ok: false, error: "name must be a string" };
  }
  if (Object.hasOwn(body, "setupProfiles")) {
    if (!Array.isArray(body.setupProfiles)) {
      return { ok: false, error: "setupProfiles must be an array" };
    }
    for (const profile of body.setupProfiles) {
      if (
        !profile ||
        typeof profile !== "object" ||
        typeof (profile as Record<string, unknown>).id !== "string" ||
        typeof (profile as Record<string, unknown>).name !== "string" ||
        typeof (profile as Record<string, unknown>).script !== "string"
      ) {
        return { ok: false, error: "each setup profile must have string id, name, and script" };
      }
    }
  }
  if (
    Object.hasOwn(body, "defaultSetupProfileId") &&
    typeof body.defaultSetupProfileId !== "string" &&
    body.defaultSetupProfileId !== null
  ) {
    return { ok: false, error: "defaultSetupProfileId must be a string or null" };
  }
  if (
    Object.hasOwn(body, "destroyWorkspaceAfter") &&
    typeof body.destroyWorkspaceAfter !== "boolean"
  ) {
    return { ok: false, error: "destroyWorkspaceAfter must be a boolean" };
  }
  return {
    ok: true,
    input: {
      ...(typeof body.name === "string" ? { name: body.name } : requireName ? { name: "" } : {}),
      ...(Array.isArray(body.setupProfiles) ? { setupProfiles: body.setupProfiles as never } : {}),
      ...(typeof body.defaultSetupProfileId === "string" || body.defaultSetupProfileId === null
        ? { defaultSetupProfileId: body.defaultSetupProfileId }
        : {}),
      ...(typeof body.destroyWorkspaceAfter === "boolean"
        ? { destroyWorkspaceAfter: body.destroyWorkspaceAfter }
        : {}),
    },
  };
}

function parsedPoolInput(
  ctx: RouteCtx,
  body: unknown,
  requireName: boolean,
): WorkspacePoolInput | Partial<Omit<WorkspacePoolInput, "id">> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendRouteError(ctx.res, 400, "VALIDATION_ERROR", "request body must be an object");
    return null;
  }
  const parsed = poolInput(body as Record<string, unknown>, requireName);
  if (parsed.ok) return parsed.input;
  sendRouteError(ctx.res, 400, "VALIDATION_ERROR", parsed.error);
  return null;
}

/** Global workspace-pool configuration. Raw scripts are accepted only on these admin routes. */
export async function handleWorkspacePoolRoutes(ctx: RouteCtx): Promise<boolean> {
  const { method, plane, res, url } = ctx;
  const poolPath =
    url.pathname === "/api/v1/workspace-pools" ||
    url.pathname.startsWith("/api/v1/workspace-pools/");
  if (!poolPath) return false;
  if (ctx.principal?.allowedRepositoryIds) {
    sendHiddenNotFound(res);
    return true;
  }
  if (url.pathname === "/api/v1/workspace-pools") {
    if (method === "GET") {
      try {
        await plane.listWorkspacePoolsDurable();
        send(res, 200, { items: plane.listWorkspacePoolsPublic() });
      } catch {
        sendInternalError(res);
      }
      return true;
    }
    if (method === "POST") {
      const parsed = await readJsonBody(ctx);
      if (!parsed.ok) return true;
      const input = parsedPoolInput(ctx, parsed.body, true);
      if (!input) return true;
      try {
        const result = await plane.createWorkspacePoolDurable(input as WorkspacePoolInput);
        if (!result.ok) {
          sendRouteError(res, 400, "VALIDATION_ERROR", result.error);
          return true;
        }
        if (!(await auditPoolMutation(ctx, "workspace-pool:create", result.workspacePool.id)))
          return true;
        send(res, 201, result.workspacePool);
      } catch {
        sendInternalError(res);
      }
      return true;
    }
  }
  const match = /^\/api\/v1\/workspace-pools\/([^/]+)$/.exec(url.pathname);
  const execConfigMatch = /^\/api\/v1\/workspace-pools\/([^/]+)\/exec-config$/.exec(url.pathname);
  if (execConfigMatch && method === "GET") {
    try {
      const pool = await plane.getWorkspacePoolDurable(decodeURIComponent(execConfigMatch[1]!));
      if (!pool) sendRouteError(res, 404, "NOT_FOUND", "workspace pool not found");
      else send(res, 200, pool);
    } catch {
      sendInternalError(res);
    }
    return true;
  }
  if (!match) return false;
  const id = decodeURIComponent(match[1]!);
  if (method === "GET") {
    try {
      const pool = await plane.getWorkspacePoolDurable(id);
      if (!pool) sendRouteError(res, 404, "NOT_FOUND", "workspace pool not found");
      else {
        await plane.listWorkspacePoolsDurable();
        send(
          res,
          200,
          plane.listWorkspacePoolsPublic().find((item) => item.id === id),
        );
      }
    } catch {
      sendInternalError(res);
    }
    return true;
  }
  if (method === "PUT" || method === "PATCH") {
    const parsed = await readJsonBody(ctx);
    if (!parsed.ok) return true;
    const input = parsedPoolInput(ctx, parsed.body, method === "PUT");
    if (!input) return true;
    try {
      const result = await plane.updateWorkspacePoolDurable(
        id,
        input as Partial<Omit<WorkspacePoolInput, "id">>,
      );
      if (!result.ok) {
        sendRouteError(
          res,
          result.error === "workspace pool not found" ? 404 : 400,
          result.error === "workspace pool not found" ? "NOT_FOUND" : "VALIDATION_ERROR",
          result.error,
        );
      } else {
        if (!(await auditPoolMutation(ctx, "workspace-pool:update", id))) return true;
        send(res, 200, result.workspacePool);
      }
    } catch {
      sendInternalError(res);
    }
    return true;
  }
  if (method === "DELETE") {
    try {
      const result = await plane.deleteWorkspacePoolDurable(id);
      if (!result.ok) {
        sendRouteError(
          res,
          result.error === "workspace pool not found" ? 404 : 409,
          result.error === "workspace pool not found" ? "NOT_FOUND" : "CONFLICT",
          result.error,
        );
      } else {
        if (!(await auditPoolMutation(ctx, "workspace-pool:delete", id))) return true;
        send(res, 204, null);
      }
    } catch {
      sendInternalError(res);
    }
    return true;
  }
  return false;
}
