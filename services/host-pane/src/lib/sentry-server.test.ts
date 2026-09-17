import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({
  captureRequestError: vi.fn(),
  flush: vi.fn(async () => true),
  init: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("initHostPaneSentryServer", () => {
  it("skips init without a DSN and inits when one is set", async () => {
    const Sentry = await import("@sentry/nextjs");
    const { initHostPaneSentryServer } = await import("./sentry-server.ts");
    expect(initHostPaneSentryServer({})).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
    expect(
      initHostPaneSentryServer({
        HARNESS_HOST_PANE_SENTRY_DSN_SERVER: "https://abc123@o1.ingest.sentry.io/450",
      }),
    ).toBe(true);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://abc123@o1.ingest.sentry.io/450",
        environment: "local",
      }),
    );
    expect(
      initHostPaneSentryServer({
        HARNESS_DEPLOY_ENVIRONMENT: " qa ",
        HARNESS_HOST_PANE_SENTRY_DSN_SERVER: "https://abc123@o1.ingest.sentry.io/450",
      }),
    ).toBe(true);
    expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({ environment: "qa" }));
  });
});

describe("captureHostPaneRequestError", () => {
  const request = { path: "/broken", method: "GET", headers: {} };
  const errorContext = { routerKind: "App Router", routePath: "/broken", routeType: "render" };

  it("does not call the SDK at all without a DSN", async () => {
    const Sentry = await import("@sentry/nextjs");
    const { captureHostPaneRequestError } = await import("./sentry-server.ts");
    const error = new Error("boom");

    await captureHostPaneRequestError(error, request as never, errorContext as never, {});

    expect(Sentry.captureRequestError).not.toHaveBeenCalled();
    expect(Sentry.flush).not.toHaveBeenCalled();
  });

  it("captures and flushes when a DSN is set", async () => {
    const Sentry = await import("@sentry/nextjs");
    const { captureHostPaneRequestError } = await import("./sentry-server.ts");
    const error = new Error("boom");
    const env = { HARNESS_HOST_PANE_SENTRY_DSN_SERVER: "https://abc123@o1.ingest.sentry.io/450" };

    await captureHostPaneRequestError(error, request as never, errorContext as never, env);

    expect(Sentry.captureRequestError).toHaveBeenCalledWith(error, request, errorContext);
    expect(Sentry.flush).toHaveBeenCalledWith(2_000);
  });
});
