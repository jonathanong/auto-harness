import { expect, type Page } from "@playwright/test";

/**
 * Next.js control-flow helpers (`redirect()`, `notFound()`, `forbidden()`, …) work by
 * throwing an `Error` whose `.digest` carries an internal prefix — e.g.
 * `NEXT_REDIRECT;replace;/login;307;` — that Next's own renderer intercepts to act on
 * (issue the real HTTP redirect, render the not-found boundary, …). A `catch` site
 * that swallows one of these and stringifies the error (e.g. via a generic
 * `thrownMessage(e)` helper) renders that digest as literal, user-visible text
 * instead. Confirmed live: the deployed `/hosts` page's HTML contained verbatim
 * `<p class="text-sm text-red-700">NEXT_REDIRECT</p>` instead of redirecting to
 * `/login` — `apiGet`'s `redirect("/login")` on a 401 was thrown inside a page's
 * try/catch and swallowed.
 *
 * This string (and the `NEXT_<UPPER_CASE>;` digest shape generally) can never
 * legitimately appear in real user-facing copy, so asserting its absence is a cheap,
 * broad regression guard against *any* catch site swallowing one of these — not just
 * the one bug this was written for.
 */
export async function expectNoLeakedNextDigest(page: Page): Promise<void> {
  const html = await page.content();
  expect(html, "page HTML must never contain a swallowed NEXT_REDIRECT digest").not.toContain(
    "NEXT_REDIRECT",
  );
  expect(
    html,
    "page HTML must never contain a swallowed Next.js control-flow digest (NEXT_<NAME>;...)",
  ).not.toMatch(/NEXT_[A-Z_]+;/);
}
