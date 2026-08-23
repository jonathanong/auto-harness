import { afterEach, describe, expect, it, vi } from "vitest";

const originalApiHttp = process.env.HARNESS_API_HTTP;
const originalApiUrl = process.env.HARNESS_API_URL;
const originalViewerWsUrl = process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL;
const originalWebCloud = process.env.HARNESS_WEB_CLOUD;
const originalE2e = process.env.HARNESS_E2E;

afterEach(() => {
  vi.resetModules();
  restoreEnv("HARNESS_API_HTTP", originalApiHttp);
  restoreEnv("HARNESS_API_URL", originalApiUrl);
  restoreEnv("NEXT_PUBLIC_HARNESS_VIEWER_WS_URL", originalViewerWsUrl);
  restoreEnv("HARNESS_WEB_CLOUD", originalWebCloud);
  restoreEnv("HARNESS_E2E", originalE2e);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function loadCspHeader(): Promise<string> {
  vi.resetModules();
  const { default: config } = await import("./next.config.ts");
  const headerSets = await config.headers!();
  const headers = headerSets.find((entry) => entry.source === "/(.*)")!.headers;
  return headers.find((h) => h.key === "Content-Security-Policy")!.value;
}

describe("services/web CSP connect-src", () => {
  it("skips duplicate type checking only for E2E builds", async () => {
    delete process.env.HARNESS_E2E;
    vi.resetModules();
    let { default: config } = await import("./next.config.ts");
    expect(config.typescript?.ignoreBuildErrors).toBe(false);

    process.env.HARNESS_E2E = "1";
    vi.resetModules();
    ({ default: config } = await import("./next.config.ts"));
    expect(config.typescript?.ignoreBuildErrors).toBe(true);
  });

  it("derives connect-src from apiUpstream when no viewer override is set", async () => {
    delete process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL;
    process.env.HARNESS_API_HTTP = "http://127.0.0.1:7420";
    const csp = await loadCspHeader();
    expect(csp).toContain("connect-src 'self' ws://127.0.0.1:7420");
  });

  it("derives connect-src from NEXT_PUBLIC_HARNESS_VIEWER_WS_URL when it names a different origin", async () => {
    process.env.HARNESS_API_HTTP = "http://127.0.0.1:7420";
    process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL = "wss://viewer.example.com:9443/ws/viewer";
    const csp = await loadCspHeader();
    expect(csp).toContain("connect-src 'self' wss://viewer.example.com:9443");
    expect(csp).not.toContain("7420");
  });

  it("falls back to apiUpstream when NEXT_PUBLIC_HARNESS_VIEWER_WS_URL is not a parseable URL", async () => {
    process.env.HARNESS_API_HTTP = "http://127.0.0.1:7420";
    process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL = "not-a-url";
    const csp = await loadCspHeader();
    expect(csp).toContain("connect-src 'self' ws://127.0.0.1:7420");
  });

  it("bakes the same effective viewer URL into the client env as the CSP is derived from", async () => {
    process.env.HARNESS_API_HTTP = "http://127.0.0.1:7420";
    process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL = "wss://viewer.example.com:9443/ws/viewer";
    vi.resetModules();
    const { default: config } = await import("./next.config.ts");
    expect(config.env!.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL).toBe(
      "wss://viewer.example.com:9443/ws/viewer",
    );
  });

  it("uses same-origin CloudFront routes in a cloud build", async () => {
    process.env.HARNESS_WEB_CLOUD = "1";
    vi.resetModules();
    const { default: config } = await import("./next.config.ts");
    expect(config.output).toBe("standalone");
    expect(config.env).toBeUndefined();
    expect(await config.rewrites!()).toEqual([]);
    const headerSets = await config.headers!();
    expect(headerSets).toContainEqual({
      source: "/_next/static/:path*",
      headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
    });
    const csp = await loadCspHeader();
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("ws://127.0.0.1:7420");
  });
});
