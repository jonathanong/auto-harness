import { describe, expect, it } from "vitest";

import { renderPage, stubApi } from "../../../../test-helpers/route-test-helpers.tsx";
import SsrProbePage from "./page.tsx";

describe("unauthenticated SSR probe route", () => {
  it("renders the success marker when /health reports ok", async () => {
    stubApi({ "/health": { ok: true } });
    const html = await renderPage(SsrProbePage());
    expect(html).toContain('data-pw="probe-ssr-ok"');
    expect(html).toContain("probe: ok");
  });

  it("does not render the success marker when the response body says ok is false", async () => {
    stubApi({ "/health": { ok: false } });
    const html = await renderPage(SsrProbePage());
    expect(html).not.toContain("probe-ssr-ok");
    expect(html).toContain("probe: unavailable");
  });

  it("does not render the success marker, or any error detail, when the fetch fails", async () => {
    stubApi({ "/health": new Error("connect ECONNREFUSED 127.0.0.1:7420") });
    const html = await renderPage(SsrProbePage());
    expect(html).not.toContain("probe-ssr-ok");
    expect(html).toContain("probe: unavailable");
    // Requirement: expose no data whatsoever beyond a generic failure marker.
    expect(html).not.toContain("ECONNREFUSED");
    expect(html).not.toContain("7420");
  });

  it("does not render the success marker on a non-2xx /health response", async () => {
    stubApi({ "/health": new Response(null, { status: 500 }) });
    const html = await renderPage(SsrProbePage());
    expect(html).not.toContain("probe-ssr-ok");
    expect(html).toContain("probe: unavailable");
  });

  it("re-throws a Next control-flow error instead of swallowing it into the failure marker", async () => {
    // apiGet() calls redirect("/login") on a 401 in HARNESS_AUTH_MODE=required — this must
    // escape the page uncaught, exactly like every other app/**/page.tsx (see hosts/page.test.tsx's
    // equivalent regression test), never render as a generic failure marker.
    const originalAuthMode = process.env.HARNESS_AUTH_MODE;
    process.env.HARNESS_AUTH_MODE = "required";
    try {
      stubApi({ "/health": new Response(null, { status: 401 }) });
      let caught: unknown;
      let html: string | undefined;
      try {
        html = await renderPage(SsrProbePage());
      } catch (error) {
        caught = error;
      }
      expect(html).toBeUndefined();
      expect(caught).toMatchObject({
        digest: expect.stringMatching(/^NEXT_REDIRECT;replace;\/login;/),
      });
    } finally {
      if (originalAuthMode === undefined) delete process.env.HARNESS_AUTH_MODE;
      else process.env.HARNESS_AUTH_MODE = originalAuthMode;
    }
  });
});
