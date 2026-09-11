import { afterEach, describe, expect, it, vi } from "vitest";

const initWebSentryServer = vi.hoisted(() => vi.fn());

vi.mock("./lib/sentry-server.ts", () => ({ initWebSentryServer }));

afterEach(() => {
  vi.unstubAllEnvs();
  initWebSentryServer.mockReset();
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
});
