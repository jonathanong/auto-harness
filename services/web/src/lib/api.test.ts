import { afterEach, describe, expect, it, vi } from "vitest";

// An anonymous request (empty Headers, no throw) exercises incomingAuthHeaders()'s
// "nothing to forward" branch specifically — distinct from the no-request-context
// catch branch that api-pagination.test.ts already covers by not mocking this module.
const headerState = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => headerState.headers }));

import { apiGet } from "./api.ts";

describe("apiGet CloudFront ingress token", () => {
  afterEach(() => {
    delete process.env.HARNESS_CLOUDFRONT_INGRESS_TOKEN;
    headerState.headers = new Headers();
    vi.unstubAllGlobals();
  });

  it("omits the header when HARNESS_CLOUDFRONT_INGRESS_TOKEN is unset", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);

    await apiGet("/api/v1/hosts");

    // Local dev and the API's own tests never set the token — the fetch init must stay
    // byte-identical to before this change (no `headers` key at all).
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/v1/hosts"), {
      cache: "no-store",
    });
  });

  it("sends the ingress header alongside forwarded auth when the token is configured", async () => {
    headerState.headers = new Headers({ cookie: "auto_harness_session=abc" });
    process.env.HARNESS_CLOUDFRONT_INGRESS_TOKEN = "shh-secret";
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);

    await apiGet("/api/v1/hosts");

    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/v1/hosts"), {
      cache: "no-store",
      headers: {
        cookie: "auto_harness_session=abc",
        "x-auto-harness-ingress-token": "shh-secret",
      },
    });
  });

  it("still sends the token when there is no incoming cookie or authorization header", async () => {
    // Regression: the old `...(forwarded ? { headers: forwarded } : {})` spread made
    // `headers` — and the ingress token with it — disappear from the fetch init
    // whenever there was nothing to forward. headerState.headers is already empty here.
    process.env.HARNESS_CLOUDFRONT_INGRESS_TOKEN = "shh-secret";
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);

    await apiGet("/api/v1/hosts");

    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/v1/hosts"), {
      cache: "no-store",
      headers: { "x-auto-harness-ingress-token": "shh-secret" },
    });
  });
});
