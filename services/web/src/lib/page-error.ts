import { thrownMessage } from "@auto-harness/shared";
import { unstable_rethrow } from "next/navigation";

/**
 * Rethrow Next.js control-flow errors (redirect()/notFound()/forbidden()/unauthorized(),
 * plus framework-internal signals such as dynamic-API bailouts) so the framework can act
 * on them; does nothing for a genuine error.
 *
 * These APIs work by THROWING an error whose `.digest` Next's rendering machinery must
 * see uncaught — e.g. redirect()'s digest is "NEXT_REDIRECT;replace;/login;307;". A page
 * catch block that swallows "whatever apiGet() threw" swallows this too: the digest then
 * gets treated as an ordinary error message, so a user sees the literal string
 * "NEXT_REDIRECT" where a redirect should have happened. apiGet() calls redirect("/login")
 * on a 401 in HARNESS_AUTH_MODE=required, so this is a live bug, not a hypothetical one.
 *
 * `unstable_rethrow` (exported from the public `next/navigation` entry point) is Next's
 * own documented answer to exactly this problem — its doc comment says to use it when
 * "wrapping an API that uses errors to interrupt control flow ... before you do any error
 * handling." It is used here instead of hand-rolling isRedirectError/
 * isHTTPAccessFallbackError checks because neither predicate is exported from a public
 * path in the installed next@16.3.4 — both live only under
 * next/dist/client/components/{redirect-error,http-access-fallback/http-access-fallback}.
 * unstable_rethrow's internal isNextRouterError check already covers both (redirect AND
 * notFound/forbidden/unauthorized), plus other internal control-flow signals (dynamic
 * server errors, postpone, bailout-to-CSR) that a page catch block should equally never
 * treat as a "real" error. Its "unstable_" prefix marks API surface, not behavior — Next
 * still ships and documents it for exactly this use, so it beats reaching into dist
 * internals or re-deriving the digest format ourselves.
 */
export function rethrowControlFlowError(error: unknown): void {
  unstable_rethrow(error);
}

/**
 * Display-safe text for a caught page-data-fetch error. Rethrows control-flow errors
 * first (see rethrowControlFlowError) so the raw "NEXT_REDIRECT"/"NEXT_HTTP_ERROR_FALLBACK"
 * digest can never reach the UI as if it were a real error message.
 */
export function pageErrorMessage(error: unknown): string {
  rethrowControlFlowError(error);
  return thrownMessage(error);
}
