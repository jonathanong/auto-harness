import { describe, expect, it } from "vitest";

import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from "./security-headers.ts";

/**
 * Neither Next.js app set any of these before, despite gating destructive actions
 * (cancel session, delete repository, drain host) behind nothing but a same-origin
 * session cookie. This is what both next.config.ts headers() functions render into
 * an actual response — a regression here silently drops protection from both apps.
 */
describe("SECURITY_HEADERS", () => {
  it("blocks framing entirely", () => {
    expect(SECURITY_HEADERS).toContainEqual({ key: "X-Frame-Options", value: "DENY" });
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
  });

  it("blocks MIME-sniffing and leaks no referrer", () => {
    expect(SECURITY_HEADERS).toContainEqual({ key: "X-Content-Type-Options", value: "nosniff" });
    expect(SECURITY_HEADERS).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
  });

  it("forces HTTPS for a year including subdomains", () => {
    const hsts = SECURITY_HEADERS.find((h) => h.key === "Strict-Transport-Security");
    expect(hsts?.value).toBe("max-age=63072000; includeSubDomains");
  });

  it("restricts every fetchable resource type to same-origin", () => {
    for (const directive of ["default-src", "script-src", "style-src", "connect-src", "font-src"]) {
      expect(CONTENT_SECURITY_POLICY).toContain(`${directive} 'self'`);
    }
  });

  it("blocks plugins and third-party form submission", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("form-action 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("base-uri 'self'");
  });
});
