import { send, type RouteCtx } from "./local-http.ts";
import { mayAccessHost, mayAccessRepository } from "./auth-policy.ts";
import {
  InvalidListPageQueryError,
  parseListPageQuery,
  readSingleQueryParam,
} from "./control-plane-id-page.ts";

/** Bounded worktree list and detail GET routes. */
export async function handleWorktreeReadRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, res, url, method } = ctx;
  const worktreeMatch = /^\/api\/v1\/worktrees\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && worktreeMatch) {
    try {
      const worktree = await plane.getWorktreeDurable(decodeURIComponent(worktreeMatch[1]!));
      if (
        !worktree ||
        !mayAccessHost(ctx.principal, worktree.hostId) ||
        (ctx.principal && !mayAccessRepository(ctx.principal, worktree.repositoryId))
      ) {
        send(res, 404, { error: { code: "NOT_FOUND", message: "worktree not found" } });
      } else {
        send(res, 200, worktree);
      }
    } catch {
      send(res, 500, { error: { code: "INTERNAL_ERROR", message: "internal server error" } });
    }
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/worktrees") {
    try {
      const query = parseListPageQuery(url);
      const hostId = readSingleQueryParam(url, "hostId") ?? null;
      const repositoryId = readSingleQueryParam(url, "repositoryId") ?? null;
      const page = await plane.listWorktreesPageDurable({ ...query, hostId, repositoryId });
      send(res, 200, {
        items: page.items.filter(
          (worktree) =>
            mayAccessHost(ctx.principal, worktree.hostId) &&
            (!ctx.principal || mayAccessRepository(ctx.principal, worktree.repositoryId)),
        ),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      if (error instanceof InvalidListPageQueryError) {
        send(res, 400, { error: { code: "VALIDATION_ERROR", message: error.message } });
      } else {
        send(res, 500, { error: { code: "INTERNAL_ERROR", message: "internal server error" } });
      }
    }
    return true;
  }
  return false;
}
