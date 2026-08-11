import type { RouteCtx } from "./local-http.ts";
import { handleSessionCreateRoute } from "./local-routes-session-create.ts";
import { handleSessionLifecycleRoutes } from "./local-routes-session-lifecycle.ts";
import { handleSessionReadRoutes } from "./local-routes-session-reads.ts";
import { handleSessionResumeRoute } from "./local-routes-session-resume.ts";

/** Session collection, reads, and mutations are deliberately split by action. */
export async function handleSessionRoutes(ctx: RouteCtx): Promise<boolean> {
  return (
    (await handleSessionCreateRoute(ctx)) ||
    (await handleSessionReadRoutes(ctx)) ||
    (await handleSessionLifecycleRoutes(ctx)) ||
    (await handleSessionResumeRoute(ctx))
  );
}
