import { describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));

describe("web browser Sentry helpers", () => {
  it("inits with the same-origin tunnel and reports client errors", async () => {
    const Sentry = await import("@sentry/nextjs");
    const { initBrowserSentry, reportClientError } = await import("./sentry-client.ts");
    initBrowserSentry("https://abc123@o1.ingest.sentry.io/450", "web");
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://abc123@o1.ingest.sentry.io/450",
        tunnel: "/sentry-tunnel",
        tracesSampleRate: 0,
      }),
    );
    const error = new Error("boom");
    reportClientError(error);
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });
});
