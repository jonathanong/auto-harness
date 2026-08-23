import { afterEach, describe, expect, it, vi } from "vitest";

import RootLayout from "./layout.tsx";
import { renderPage, stubApi } from "./route-test-helpers.tsx";

const headerState = vi.hoisted(() => ({ pathname: null as string | null, throws: true }));
vi.mock("next/headers", () => ({
  headers: async () => {
    if (headerState.throws) throw new Error("headers unavailable");
    return new Headers(headerState.pathname ? { "x-pathname": headerState.pathname } : {});
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  headerState.pathname = null;
  headerState.throws = true;
});

describe("control root layout", () => {
  it("renders the theme bootstrap and unauthenticated application shell", async () => {
    vi.stubEnv("HARNESS_AUTH_MODE", "disabled");
    const html = await renderPage(RootLayout({ children: "dashboard" }));
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("dashboard");
    expect(html).toContain('data-pw="control-shell"');
    expect(html).toContain('data-pw="nav-session-new"');
    expect(html).toContain("localStorage");
  });

  it("loads an authenticated principal and hides unauthorized authoring", async () => {
    vi.stubEnv("HARNESS_AUTH_MODE", "required");
    stubApi({
      "/api/v1/auth/me": {
        id: "viewer-1",
        username: "viewer",
        role: "read-only",
        kind: "user",
        capabilities: [],
      },
    });
    const html = await renderPage(RootLayout({ children: "sessions" }));
    expect(html).toContain("sessions");
    expect(html).not.toContain('data-pw="nav-session-new"');
    expect(html).toContain('data-pw="logout"');
  });

  it("uses the request pathname to keep the login layout unauthenticated", async () => {
    vi.stubEnv("HARNESS_AUTH_MODE", "required");
    headerState.throws = false;
    headerState.pathname = "/login";
    const html = await renderPage(RootLayout({ children: "login" }));
    expect(html).toContain("login");
    expect(html).toContain('data-pw="control-shell"');
  });
});
