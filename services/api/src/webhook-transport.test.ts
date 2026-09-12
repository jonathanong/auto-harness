import { describe, expect, it } from "vitest";

import {
  createSignedWebhookTransport,
  DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_256_HEADER,
  signWebhookBody,
} from "./webhook-delivery-types.ts";

const request = {
  idempotencyKey: "delivery-1",
  destination: { configurationId: "cfg", configurationVersion: 2 },
  event: {
    schemaVersion: 1 as const,
    id: "event-1",
    type: "session.terminal" as const,
    occurredAt: "2026-09-12T00:00:00.000Z",
    subject: { type: "session" as const, id: "session-1" },
    data: { repositoryId: "repo", attemptId: null, status: "completed" as const },
  },
  body: '{"ok":true}',
};

describe("signed webhook transport", () => {
  it("signs exact bytes and sends stable event/delivery headers", async () => {
    const fetch = async (_url: string, init?: RequestInit) => {
      expect(init).toBeDefined();
      if (!init) throw new Error("missing request init");
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.body).toBe(request.body);
      const headers = init.headers as Record<string, string>;
      expect(headers[WEBHOOK_SIGNATURE_256_HEADER]).toBe(signWebhookBody("secret", request.body));
      expect(headers[WEBHOOK_EVENT_HEADER]).toBe("event-1");
      expect(headers[WEBHOOK_DELIVERY_HEADER]).toBe("delivery-1");
      return new Response(null, { status: 204 });
    };
    const transport = createSignedWebhookTransport({
      resolveDestination: async () => ({ url: "https://example.test/hook", secret: "secret" }),
      fetch,
    });
    await expect(transport.deliver(request)).resolves.toEqual({ ok: true });
  });

  it.each([408, 429, 500, 503])("retries HTTP %s", async (status) => {
    const transport = createSignedWebhookTransport({
      resolveDestination: async () => ({ url: "https://example.test/hook", secret: "secret" }),
      fetch: async () => new Response(null, { status }),
    });
    await expect(transport.deliver(request)).resolves.toEqual({
      ok: false,
      failureCode: "transient-failure",
    });
  });

  it("classifies other client failures as permanent and missing config as unavailable", async () => {
    const permanent = createSignedWebhookTransport({
      resolveDestination: async () => ({ url: "https://example.test/hook", secret: "secret" }),
      fetch: async () => new Response(null, { status: 422 }),
    });
    await expect(permanent.deliver(request)).resolves.toEqual({
      ok: false,
      failureCode: "delivery-rejected",
    });
    const absent = createSignedWebhookTransport({ resolveDestination: async () => null });
    await expect(absent.deliver(request)).resolves.toEqual({
      ok: false,
      failureCode: "configuration-unavailable",
    });
  });

  it("treats network and timeout failures as transient", async () => {
    const network = createSignedWebhookTransport({
      resolveDestination: async () => ({ url: "https://example.test/hook", secret: "secret" }),
      fetch: async () => {
        throw new Error("connection reset");
      },
    });
    await expect(network.deliver(request)).resolves.toEqual({
      ok: false,
      failureCode: "transient-failure",
    });
    let signal: AbortSignal | undefined;
    const timeout = createSignedWebhookTransport({
      resolveDestination: async () => ({
        url: "https://example.test/hook",
        secret: "secret",
        timeoutMs: 1,
      }),
      fetch: async (_url, init) => {
        signal = init?.signal ?? undefined;
        throw new DOMException("timed out", "TimeoutError");
      },
    });
    await expect(timeout.deliver(request)).resolves.toEqual({
      ok: false,
      failureCode: "transient-failure",
    });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects invalid or lease-exceeding timeout overrides before sending", async () => {
    for (const timeoutMs of [0, -1, Number.NaN, DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS + 1]) {
      let called = false;
      const transport = createSignedWebhookTransport({
        resolveDestination: async () => ({
          url: "https://example.test/hook",
          secret: "secret",
          timeoutMs,
        }),
        fetch: async () => {
          called = true;
          return new Response(null, { status: 204 });
        },
      });
      await expect(transport.deliver(request)).resolves.toEqual({
        ok: false,
        failureCode: "configuration-unavailable",
      });
      expect(called).toBe(false);
    }
  });

  it("rejects insecure production destinations before making a request", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      let called = false;
      const transport = createSignedWebhookTransport({
        resolveDestination: async () => ({ url: "http://example.test/hook", secret: "secret" }),
        fetch: async () => {
          called = true;
          return new Response(null, { status: 204 });
        },
      });
      await expect(transport.deliver(request)).resolves.toEqual({
        ok: false,
        failureCode: "configuration-unavailable",
      });
      expect(called).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});
