import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({
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
      expect.objectContaining({ dsn: "https://abc123@o1.ingest.sentry.io/450" }),
    );
  });
});
