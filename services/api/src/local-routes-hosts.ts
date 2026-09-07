import { send, type RouteCtx } from "./local-http.ts";
import { mayAccessHost, mayAccessRepository } from "./auth-policy.ts";
import { InvalidListPageQueryError, readSingleQueryParam } from "./control-plane-id-page.ts";
import { sendListPage } from "./local-list-page.ts";

type ListedHost = Awaited<ReturnType<RouteCtx["plane"]["listHostsDurable"]>>[number];

function hostIsVisible(ctx: RouteCtx, host: ListedHost): boolean {
  return (
    mayAccessHost(ctx.principal, host.hostId) &&
    (!ctx.principal?.allowedRepositoryIds ||
      host.repositoryIds.some((id) => mayAccessRepository(ctx.principal, id)) ||
      host.worktreeIds.some((id) =>
        mayAccessRepository(ctx.principal, ctx.plane.getWorktree(id)?.repositoryId),
      ))
  );
}

function readOnlineFilter(url: URL): "online" | "offline" | null {
  const value = readSingleQueryParam(url, "online") ?? null;
  if (value === null || value === "all") return null;
  if (value === "online" || value === "offline") return value;
  throw new InvalidListPageQueryError("online must be online or offline");
}

/** Bounded host list and single-host GET — callers must not list the fleet to find one host. */
export async function handleHostReadRoutes(ctx: RouteCtx): Promise<boolean> {
  const { plane, res, url, method } = ctx;
  const hostMatch = /^\/api\/v1\/hosts\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && hostMatch) {
    try {
      const host = await plane.getHostDurable(decodeURIComponent(hostMatch[1]!));
      if (!host || !hostIsVisible(ctx, host)) {
        send(res, 404, { error: { code: "NOT_FOUND", message: "host not found" } });
      } else {
        send(res, 200, host);
      }
    } catch {
      send(res, 500, { error: { code: "INTERNAL_ERROR", message: "internal server error" } });
    }
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/hosts") {
    try {
      const online = readOnlineFilter(url);
      sendListPage(
        ctx,
        (await plane.listHostsDurable()).filter((host) => {
          if (!hostIsVisible(ctx, host)) return false;
          if (online === "online") return host.online;
          if (online === "offline") return !host.online;
          return true;
        }),
        (host) => host.hostId,
      );
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
