import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route.ts";

describe("host pane live log proxy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("pipes the daemon SSE body", async () => {
    vi.stubEnv("HARNESS_DAEMON_HTTP", "http://127.0.0.1:7424");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("data: hi\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    const response = await GET(new Request("http://127.0.0.1/live-logs/s"), {
      params: Promise.resolve({ id: "s" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("hi");
  });

  it("returns 502 when the daemon is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    const response = await GET(new Request("http://127.0.0.1/live-logs/s"), {
      params: Promise.resolve({ id: "s" }),
    });
    expect(response.status).toBe(502);
  });
});
