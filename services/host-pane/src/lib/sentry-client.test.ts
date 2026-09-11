import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("host-pane browser Sentry helpers", () => {
  it("inits with the same-origin tunnel and reports client errors", async () => {
    const Sentry = await import("@sentry/nextjs");
    const { initBrowserSentry, reportClientError } = await import("./sentry-client.ts");
    initBrowserSentry("https://abc123@o1.ingest.sentry.io/450");
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: "local",
        tunnel: "/sentry-tunnel",
        tracesSampleRate: 0,
      }),
    );
    const error = new Error("boom");
    reportClientError(error);
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it("tags the production environment when NODE_ENV is production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const Sentry = await import("@sentry/nextjs");
    const { initBrowserSentry } = await import("./sentry-client.ts");
    initBrowserSentry("https://abc123@o1.ingest.sentry.io/450");
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "production" }),
    );
  });
});
