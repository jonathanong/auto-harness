import { describe, expect, it } from "vitest";

import { contentSecurityPolicy, securityHeaders, wsOrigin } from "./security-headers.ts";

/**
 * Neither Next.js app set any of these before, despite gating destructive actions
 * (cancel session, delete repository, drain host) behind nothing but a same-origin
 * session cookie. This is what both next.config.ts headers() functions render into
 * an actual response — a regression here silently drops protection from both apps.
 */
describe("securityHeaders / contentSecurityPolicy", () => {
  it("blocks framing entirely", () => {
    expect(securityHeaders()).toContainEqual({ key: "X-Frame-Options", value: "DENY" });
    expect(contentSecurityPolicy()).toContain("frame-ancestors 'none'");
  });

  it("blocks MIME-sniffing and leaks no referrer", () => {
    expect(securityHeaders()).toContainEqual({ key: "X-Content-Type-Options", value: "nosniff" });
    expect(securityHeaders()).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
  });

  it("forces HTTPS for a year including subdomains", () => {
    const hsts = securityHeaders().find((h) => h.key === "Strict-Transport-Security");
    expect(hsts?.value).toBe("max-age=63072000; includeSubDomains");
  });

  it("restricts every fetchable resource type to same-origin by default", () => {
    const csp = contentSecurityPolicy();
    for (const directive of ["default-src", "script-src", "style-src", "connect-src", "font-src"]) {
      expect(csp).toContain(`${directive} 'self'`);
    }
  });

  it("blocks plugins and third-party form submission", () => {
    const csp = contentSecurityPolicy();
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'self'");
  });

  /**
   * The live-log viewer's WebSocket connects directly to the control-plane API's own
   * origin, not through the Next.js rewrite — a WebSocket upgrade can't be proxied the
   * way a plain fetch() can. That origin is a different port than the page in every
   * local/e2e layout, so a bare `connect-src 'self'` silently blocked it: CI caught this
   * as "Connecting live logs…" never resolving, and the e2e harness's own direct
   * WebSocket calls (`new WebSocket("ws://127.0.0.1:7430/ws")`, run inside
   * `page.evaluate` and so equally subject to the page's CSP) failing outright.
   */
  it("allows an explicit extra connect-src origin alongside 'self'", () => {
    const csp = contentSecurityPolicy({ connectSrcOrigins: ["ws://127.0.0.1:7430"] });
    expect(csp).toContain("connect-src 'self' ws://127.0.0.1:7430");
    // Every other directive stays same-origin-only — this isn't a blanket relaxation.
    for (const directive of ["default-src", "script-src", "style-src", "font-src"]) {
      expect(csp).toContain(`${directive} 'self'`);
    }
  });

  it("threads connectSrcOrigins through securityHeaders into the CSP header value", () => {
    const headers = securityHeaders({ connectSrcOrigins: ["ws://127.0.0.1:7430"] });
    const csp = headers.find((h) => h.key === "Content-Security-Policy");
    expect(csp?.value).toContain("connect-src 'self' ws://127.0.0.1:7430");
  });
});

describe("wsOrigin", () => {
  it("matches next.config.ts's existing http-to-ws scheme swap for the default local origin", () => {
    expect(wsOrigin("http://127.0.0.1:7420")).toBe("ws://127.0.0.1:7420");
  });

  it("matches the e2e origin actually used by CI (HARNESS_API_HTTP=:7430)", () => {
    expect(wsOrigin("http://127.0.0.1:7430")).toBe("ws://127.0.0.1:7430");
  });

  it("upgrades https to wss for a real deployment", () => {
    expect(wsOrigin("https://api.example.com")).toBe("wss://api.example.com");
  });
});
