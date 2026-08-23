import { describe, expect, it } from "vitest";

import { fetchControlPlaneHostStatus } from "./host-status.ts";

const identity = {
  hostId: "host-1",
  apiUrl: "https://control.example/ws",
  apiKey: "secret-token",
};

describe("fetchControlPlaneHostStatus", () => {
  it("queries the exact host with the persisted API key and parses readiness", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const result = await fetchControlPlaneHostStatus(identity, async (url, init) => {
      request = { url, init };
      return new Response(
        JSON.stringify({
          items: [
            {
              hostId: "other",
              online: true,
              gitReady: true,
            },
            {
              hostId: "host-1",
              online: true,
              connectedAt: "2026-08-21T10:00:00.000Z",
              draining: false,
              daemonVersion: "1.2.3",
              gitVersion: "2.45.0",
              gitReady: true,
              gitReadinessReason: "git executable available",
            },
          ],
        }),
        { status: 200 },
      );
    });
    expect(request?.url).toBe("https://control.example/api/v1/hosts");
    expect(request?.init?.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer secret-token",
    });
    expect(request?.init?.signal).toBeUndefined();
    expect(result).toMatchObject({
      reachable: true,
      hostId: "host-1",
      online: true,
      connectedAt: "2026-08-21T10:00:00.000Z",
      draining: false,
      daemonVersion: "1.2.3",
      gitVersion: "2.45.0",
      gitReady: true,
    });
  });

  it("forwards an abort signal to the bounded control-plane request", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    await fetchControlPlaneHostStatus(
      identity,
      async (_url, init) => {
        signal = init?.signal;
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      },
      controller.signal,
    );
    expect(signal).toBe(controller.signal);
  });

  it("fails closed for absent, offline, and legacy readiness", async () => {
    const absent = await fetchControlPlaneHostStatus(
      identity,
      async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    expect(absent).toMatchObject({
      reachable: true,
      online: null,
      draining: null,
      gitReady: null,
    });

    const legacy = await fetchControlPlaneHostStatus(
      identity,
      async () =>
        new Response(
          JSON.stringify({ items: [{ hostId: "host-1", online: true, draining: false }] }),
          {
            status: 200,
          },
        ),
    );
    expect(legacy.gitReady).toBeNull();

    const unreachable = await fetchControlPlaneHostStatus(identity, async () => {
      throw new Error("network secret-token should not escape");
    });
    expect(unreachable).toEqual({
      reachable: false,
      hostId: "host-1",
      online: null,
      connectedAt: null,
      draining: null,
      gitReady: null,
      reason: "control plane is unreachable",
    });
  });

  it("does not read or expose error response bodies", async () => {
    const result = await fetchControlPlaneHostStatus(
      identity,
      async () => new Response("Bearer secret-token leaked", { status: 500 }),
    );
    expect(result.reason).toBe("control plane request failed");
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("handles invalid JSON, malformed item collections, and untyped optional fields", async () => {
    const invalid = await fetchControlPlaneHostStatus(
      { ...identity, apiKey: "" },
      async () => new Response("not-json", { status: 200 }),
    );
    expect(invalid.reason).toBe("control plane returned invalid host status");

    for (const body of [null, {}, { items: [null, "host-1", { hostId: "other" }] }]) {
      const result = await fetchControlPlaneHostStatus(
        identity,
        async () => new Response(JSON.stringify(body), { status: 200 }),
      );
      expect(result.reason).toBe("exact host is absent from the control plane");
    }

    const malformed = await fetchControlPlaneHostStatus(
      identity,
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                hostId: "host-1",
                online: "yes",
                connectedAt: 1,
                draining: "no",
                gitReady: "yes",
                daemonVersion: "",
                gitVersion: 2,
                gitReadinessReason: null,
              },
            ],
          }),
          { status: 200 },
        ),
    );
    expect(malformed).toMatchObject({
      online: null,
      connectedAt: null,
      draining: null,
      gitReady: null,
    });
    expect(malformed).not.toHaveProperty("daemonVersion");
  });
});
