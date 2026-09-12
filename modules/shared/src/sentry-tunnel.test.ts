import { describe, expect, it, vi } from "vitest";

import {
  evaluateSentryTunnel,
  forwardSentryTunnel,
  isSentryTunnelPath,
  SENTRY_TUNNEL_MAX_BYTES,
} from "./sentry-tunnel.ts";

const dsn = "https://abc123@o1.ingest.sentry.io/450";
const envelope = `{"dsn":"${dsn}"}\n{}`;

describe("isSentryTunnelPath", () => {
  it("matches the tunnel path with or without a trailing slash", () => {
    expect(isSentryTunnelPath("/sentry-tunnel")).toBe(true);
    expect(isSentryTunnelPath("/sentry-tunnel/")).toBe(true);
    expect(isSentryTunnelPath("/api/sentry-tunnel")).toBe(false);
  });
});

describe("evaluateSentryTunnel", () => {
  it("is a no-op when Sentry is unset and rejects non-POST methods", () => {
    expect(
      evaluateSentryTunnel({ method: "POST", configuredDsn: undefined, body: envelope }),
    ).toEqual({
      status: 404,
    });
    expect(evaluateSentryTunnel({ method: "GET", configuredDsn: dsn, body: envelope })).toEqual({
      status: 405,
    });
  });

  it("forwards a matching envelope to the DSN ingest URL", () => {
    expect(evaluateSentryTunnel({ method: "POST", configuredDsn: dsn, body: envelope })).toEqual({
      status: 200,
      ingestUrl: "https://o1.ingest.sentry.io/api/450/envelope/",
    });
    expect(evaluateSentryTunnel({ method: "POST", configuredDsn: dsn, body: "{}\n{}" })).toEqual({
      status: 200,
      ingestUrl: "https://o1.ingest.sentry.io/api/450/envelope/",
    });
  });

  it("rejects empty, oversized, malformed, and mismatched envelopes", () => {
    expect(evaluateSentryTunnel({ method: "POST", configuredDsn: dsn, body: "" })).toEqual({
      status: 400,
    });
    expect(
      evaluateSentryTunnel({
        method: "POST",
        configuredDsn: dsn,
        body: "x".repeat(SENTRY_TUNNEL_MAX_BYTES + 1),
      }),
    ).toEqual({ status: 413 });
    expect(evaluateSentryTunnel({ method: "POST", configuredDsn: dsn, body: "not-json" })).toEqual({
      status: 400,
    });
    expect(
      evaluateSentryTunnel({
        method: "POST",
        configuredDsn: dsn,
        body: `{"dsn":"https://other@o1.ingest.sentry.io/1"}\n{}`,
      }),
    ).toEqual({ status: 403 });
    expect(
      evaluateSentryTunnel({ method: "POST", configuredDsn: dsn, body: '{"dsn":1}\n{}' }),
    ).toEqual({ status: 400 });
    expect(evaluateSentryTunnel({ method: "POST", configuredDsn: dsn, body: "1\n{}" })).toEqual({
      status: 400,
    });
  });

  it("rejects when a configured DSN cannot be turned into an ingest URL", async () => {
    const dsnModule = await import("./sentry-dsn.ts");
    const spy = vi.spyOn(dsnModule, "sentryIngestEnvelopeUrl").mockReturnValue(undefined);
    try {
      expect(evaluateSentryTunnel({ method: "POST", configuredDsn: dsn, body: envelope })).toEqual({
        status: 400,
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("forwardSentryTunnel", () => {
  it("forwards a matching envelope and maps upstream failures", async () => {
    await expect(
      forwardSentryTunnel({
        method: "POST",
        configuredDsn: dsn,
        body: envelope,
        fetchFn: async () => new Response(null, { status: 200 }),
      }),
    ).resolves.toEqual({ status: 200 });
    await expect(
      forwardSentryTunnel({
        method: "POST",
        configuredDsn: dsn,
        body: envelope,
        fetchFn: async () => new Response(null, { status: 500 }),
      }),
    ).resolves.toEqual({ status: 502 });
    await expect(
      forwardSentryTunnel({
        method: "POST",
        configuredDsn: dsn,
        body: envelope,
        fetchFn: async () => {
          throw new Error("offline");
        },
      }),
    ).resolves.toEqual({ status: 502 });
    await expect(
      forwardSentryTunnel({ method: "POST", configuredDsn: undefined, body: envelope }),
    ).resolves.toEqual({ status: 404 });
  });

  it("uses global fetch when no fetchFn is injected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    try {
      await expect(
        forwardSentryTunnel({ method: "POST", configuredDsn: dsn, body: envelope }),
      ).resolves.toEqual({ status: 200 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
