import { afterEach, describe, expect, it, vi } from "vitest";

const initHostPaneSentryServer = vi.hoisted(() => vi.fn());
const captureHostPaneRequestError = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./lib/sentry-server.ts", () => ({
  initHostPaneSentryServer,
  captureHostPaneRequestError,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  initHostPaneSentryServer.mockReset();
  captureHostPaneRequestError.mockClear();
});

describe("host-pane instrumentation", () => {
  it("inits the Node server SDK and skips the edge runtime", async () => {
    vi.resetModules();
    const { register } = await import("./instrumentation.ts");
    await register();
    expect(initHostPaneSentryServer).toHaveBeenCalledOnce();

    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.resetModules();
    const edge = await import("./instrumentation.ts");
    await edge.register();
    expect(initHostPaneSentryServer).toHaveBeenCalledOnce();
  });

  it("forwards request errors to Sentry and skips the edge runtime", async () => {
    const error = new Error("boom");
    const request = { path: "/broken", method: "GET", headers: {} };
    const errorContext = { routerKind: "App Router", routePath: "/broken", routeType: "render" };

    vi.resetModules();
    const { onRequestError } = await import("./instrumentation.ts");
    await onRequestError(error, request as never, errorContext as never);
    expect(captureHostPaneRequestError).toHaveBeenCalledWith(error, request, errorContext);

    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.resetModules();
    const edge = await import("./instrumentation.ts");
    await edge.onRequestError(error, request as never, errorContext as never);
    expect(captureHostPaneRequestError).toHaveBeenCalledTimes(1);
  });
});
