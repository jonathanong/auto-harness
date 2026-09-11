import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route.ts";

const dsn = "https://abc123@o1.ingest.sentry.io/450";
const envelope = `{"dsn":"${dsn}"}\n{}`;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("host-pane POST /sentry-tunnel", () => {
  it("returns 404 when unset and forwards a matching envelope", async () => {
    expect(
      (
        await POST(
          new Request("http://localhost/sentry-tunnel", { method: "POST", body: envelope }),
        )
      ).status,
    ).toBe(404);
    vi.stubEnv("HARNESS_HOST_PANE_SENTRY_DSN_CLIENT", dsn);
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(
      (
        await POST(
          new Request("http://localhost/sentry-tunnel", { method: "POST", body: envelope }),
        )
      ).status,
    ).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      "https://o1.ingest.sentry.io/api/450/envelope/",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
