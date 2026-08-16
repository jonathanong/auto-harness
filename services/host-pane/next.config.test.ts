import { afterEach, describe, expect, it, vi } from "vitest";

const originalApiHttp = process.env.HARNESS_API_HTTP;
const originalApiUrl = process.env.HARNESS_API_URL;
const originalViewerWsUrl = process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL;

afterEach(() => {
  vi.resetModules();
  restoreEnv("HARNESS_API_HTTP", originalApiHttp);
  restoreEnv("HARNESS_API_URL", originalApiUrl);
  restoreEnv("NEXT_PUBLIC_HARNESS_VIEWER_WS_URL", originalViewerWsUrl);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function loadCspHeader(): Promise<string> {
  vi.resetModules();
  const { default: config } = await import("./next.config.ts");
  const [{ headers }] = await config.headers!();
  return headers.find((h) => h.key === "Content-Security-Policy")!.value;
}

describe("services/host-pane CSP connect-src", () => {
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
});
