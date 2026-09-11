import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({
  init: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("initWebSentryServer", () => {
  it("skips init without a DSN and inits when one is set", async () => {
    const Sentry = await import("@sentry/nextjs");
    const { initWebSentryServer } = await import("./sentry-server.ts");
    expect(initWebSentryServer({})).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
    expect(
      initWebSentryServer({
        HARNESS_WEB_SENTRY_DSN_SERVER: "https://abc123@o1.ingest.sentry.io/450",
      }),
    ).toBe(true);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://abc123@o1.ingest.sentry.io/450",
        environment: "local",
        tracesSampleRate: 0,
      }),
    );
    expect(
      initWebSentryServer({
        HARNESS_DEPLOY_ENVIRONMENT: " qa ",
        HARNESS_WEB_SENTRY_DSN_SERVER: "https://abc123@o1.ingest.sentry.io/450",
      }),
    ).toBe(true);
    expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({ environment: "qa" }));
  });
});
