import { afterEach, describe, expect, it, vi } from "vitest";

const initHostPaneSentryServer = vi.hoisted(() => vi.fn());

vi.mock("./lib/sentry-server.ts", () => ({ initHostPaneSentryServer }));

afterEach(() => {
  vi.unstubAllEnvs();
  initHostPaneSentryServer.mockReset();
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
});
