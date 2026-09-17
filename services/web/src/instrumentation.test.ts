import { afterEach, describe, expect, it, vi } from "vitest";

const initWebSentryServer = vi.hoisted(() => vi.fn());
const captureWebRequestError = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./lib/sentry-server.ts", () => ({ initWebSentryServer, captureWebRequestError }));

afterEach(() => {
  vi.unstubAllEnvs();
  initWebSentryServer.mockReset();
  captureWebRequestError.mockClear();
});

describe("web instrumentation", () => {
  it("inits the Node server SDK and skips the edge runtime", async () => {
    vi.resetModules();
    const { register } = await import("./instrumentation.ts");
    await register();
    expect(initWebSentryServer).toHaveBeenCalledOnce();

    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.resetModules();
    const edge = await import("./instrumentation.ts");
    await edge.register();
    expect(initWebSentryServer).toHaveBeenCalledOnce();
  });

  it("forwards request errors to Sentry and skips the edge runtime", async () => {
    const error = new Error("boom");
    const request = { path: "/broken", method: "GET", headers: {} };
    const errorContext = { routerKind: "App Router", routePath: "/broken", routeType: "render" };

    vi.resetModules();
    const { onRequestError } = await import("./instrumentation.ts");
    await onRequestError(error, request as never, errorContext as never);
    expect(captureWebRequestError).toHaveBeenCalledWith(error, request, errorContext);

    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.resetModules();
    const edge = await import("./instrumentation.ts");
    await edge.onRequestError(error, request as never, errorContext as never);
    expect(captureWebRequestError).toHaveBeenCalledTimes(1);
  });
});
