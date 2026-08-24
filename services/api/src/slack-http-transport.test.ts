/* eslint-disable max-lines -- HTTP mapping, failure shapes, and outbox dead-letter share one harness. */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SlackDeliveryRecord, SlackOutboxStore } from "./slack-delivery-types.ts";
import { createSlackHttpTransport, type SlackFetcher } from "./slack-http-transport.ts";
import { processSlackOutboxOnce } from "./slack-outbox.ts";

const token = "xoxb-1234567890-abcdefghij";
const now = "2026-08-12T10:00:00.000Z";

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function request(operation: SlackDeliveryRecord["operation"] = "post-root") {
  return {
    idempotencyKey: `op-${operation}`,
    operation,
    channel: "C123",
    text: "hello",
    ...(operation === "post-reply" ? { threadTs: "1.0" } : {}),
    ...(operation === "update-root" ? { messageTs: "1.0" } : {}),
  };
}

class MemoryStore implements SlackOutboxStore {
  readonly items = new Map<string, SlackDeliveryRecord>();

  async enqueue(value: SlackDeliveryRecord) {
    if (this.items.has(value.id)) return "exists" as const;
    this.items.set(value.id, structuredClone(value));
    return "created" as const;
  }

  async claimDue(input: Parameters<SlackOutboxStore["claimDue"]>[0]) {
    const value = [...this.items.values()].find(
      (item) =>
        (item.status === "pending" || item.status === "delivering") &&
        item.nextAttemptAt <= input.now,
    );
    if (!value) return null;
    Object.assign(value, {
      status: "delivering",
      leaseToken: input.leaseToken,
      leaseExpiresAt: input.leaseExpiresAt,
      nextAttemptAt: input.leaseExpiresAt,
    });
    return structuredClone(value);
  }

  async get(id: string) {
    return structuredClone(this.items.get(id) ?? null);
  }

  async complete(input: Parameters<SlackOutboxStore["complete"]>[0]) {
    const value = this.items.get(input.id);
    if (!value || value.leaseToken !== input.leaseToken) return false;
    Object.assign(value, {
      status: "sent",
      remoteChannel: input.result.channel,
      remoteMessageTs: input.result.messageTs,
    });
    return true;
  }

  async reschedule(input: Parameters<SlackOutboxStore["reschedule"]>[0]) {
    const value = this.items.get(input.id);
    if (!value || value.leaseToken !== input.leaseToken) return false;
    Object.assign(value, input, {
      lastError: input.error,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    });
    return true;
  }
}

describe("Slack HTTP transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts, replies, updates, and deduplicates by operation ID", async () => {
    const fetchImpl = vi.fn<SlackFetcher>(async (url, init) => {
      const body = JSON.parse(init.body) as Record<string, string>;
      expect(init.headers.authorization).toBe(`Bearer ${token}`);
      if (url.endsWith("chat.update")) {
        return jsonResponse({ ok: true, channel: body.channel, ts: body.ts });
      }
      return jsonResponse({ ok: true, channel: "C999", ts: "2.0" });
    });
    const transport = createSlackHttpTransport({
      getBotToken: async () => token,
      fetch: fetchImpl,
      apiBase: "https://slack.test/api",
    });

    expect(await transport.deliver(request("post-root"))).toEqual({
      channel: "C999",
      messageTs: "2.0",
    });
    expect(await transport.deliver(request("post-root"))).toEqual({
      channel: "C999",
      messageTs: "2.0",
    });
    expect(await transport.deliver(request("post-reply"))).toEqual({
      channel: "C999",
      messageTs: "2.0",
    });
    expect(await transport.deliver(request("update-root"))).toEqual({
      channel: "C123",
      messageTs: "1.0",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchImpl.mock.calls[1]![1].body)).toMatchObject({ thread_ts: "1.0" });
    expect(JSON.parse(fetchImpl.mock.calls[2]![1].body)).toMatchObject({ ts: "1.0" });

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = vi.fn<SlackFetcher>(async () => {
      await blocked;
      return jsonResponse({ ok: true, channel: "C123", ts: "3.0" });
    });
    const overlapping = createSlackHttpTransport({ getBotToken: async () => token, fetch: slow });
    const first = overlapping.deliver(request("post-root"));
    const second = overlapping.deliver(request("post-root"));
    release();
    expect(await Promise.all([first, second])).toEqual([
      { channel: "C123", messageTs: "3.0" },
      { channel: "C123", messageTs: "3.0" },
    ]);
    expect(slow).toHaveBeenCalledTimes(1);

    const bounded = vi.fn<SlackFetcher>(async (_url, init) =>
      jsonResponse({ ok: true, channel: "C123", ts: JSON.parse(init.body).text }),
    );
    const evicting = createSlackHttpTransport({
      getBotToken: async () => token,
      fetch: bounded,
      cacheLimit: 1,
    });
    await evicting.deliver({ ...request("post-root"), idempotencyKey: "a", text: "a" });
    await evicting.deliver({ ...request("post-root"), idempotencyKey: "b", text: "b" });
    await evicting.deliver({ ...request("post-root"), idempotencyKey: "a", text: "a" });
    expect(bounded).toHaveBeenCalledTimes(3);
  });

  it("uses the default Slack API and fetch, and fails closed on token or payload errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, channel: "C123", ts: "1.0" }));
    vi.stubGlobal("fetch", fetchImpl);
    const transport = createSlackHttpTransport({ getBotToken: async () => token });
    expect(await transport.deliver(request())).toMatchObject({ messageTs: "1.0" });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://slack.com/api/chat.postMessage");

    await expect(
      createSlackHttpTransport({ getBotToken: async () => null, fetch: fetchImpl }).deliver(
        request(),
      ),
    ).rejects.toThrow("unavailable");
    await expect(
      createSlackHttpTransport({
        getBotToken: async () => token,
        fetch: async () => jsonResponse({ ok: false, error: "channel_not_found" }),
      }).deliver(request()),
    ).rejects.toThrow("channel_not_found");
    await expect(
      createSlackHttpTransport({
        getBotToken: async () => token,
        fetch: async () =>
          jsonResponse("not-json", { status: 500, headers: { "content-type": "text/plain" } }),
      }).deliver(request()),
    ).rejects.toThrow("invalid Slack response");
    await expect(
      createSlackHttpTransport({
        getBotToken: async () => token,
        fetch: async () => jsonResponse([]),
      }).deliver(request()),
    ).rejects.toThrow("invalid Slack response");
    await expect(
      createSlackHttpTransport({
        getBotToken: async () => token,
        fetch: async () => jsonResponse({ ok: true }),
      }).deliver(request()),
    ).rejects.toThrow("without a channel or timestamp");
  });

  it("surfaces rate limits and generic HTTP failures without leaking the bot token", async () => {
    await expect(
      createSlackHttpTransport({
        getBotToken: async () => token,
        fetch: async () =>
          jsonResponse({ ok: false }, { status: 429, headers: { "retry-after": "7" } }),
      }).deliver(request()),
    ).rejects.toThrow("retry after 7s");
    await expect(
      createSlackHttpTransport({
        getBotToken: async () => token,
        fetch: async () => jsonResponse({ ok: false }, { status: 429 }),
      }).deliver(request()),
    ).rejects.toThrow("rate-limited");
    await expect(
      createSlackHttpTransport({
        getBotToken: async () => token,
        fetch: async () => jsonResponse({ ok: false }, { status: 502 }),
      }).deliver(request()),
    ).rejects.toThrow("failed (502)");
  });

  it("retries Slack errors through the outbox and dead-letters at the attempt ceiling", async () => {
    const store = new MemoryStore();
    await store.enqueue({
      id: "root",
      integrationId: "slack",
      sessionId: "session-1",
      event: "session_created",
      operation: "post-root",
      channel: "C123",
      text: "queued",
      status: "pending",
      attempts: 0,
      maxAttempts: 2,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const fetchImpl = vi
      .fn<SlackFetcher>()
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: "fatal" }))
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: "fatal" }));
    const transport = createSlackHttpTransport({
      getBotToken: async () => token,
      fetch: fetchImpl,
    });
    expect(
      await processSlackOutboxOnce(store, transport, { now: () => now, leaseToken: () => "l1" }),
    ).toBe("retried");
    store.items.get("root")!.nextAttemptAt = now;
    expect(
      await processSlackOutboxOnce(store, transport, { now: () => now, leaseToken: () => "l2" }),
    ).toBe("dead");
    expect(store.items.get("root")).toMatchObject({
      status: "dead",
      attempts: 2,
      lastError: "Slack chat.postMessage failed: fatal",
    });
    expect(JSON.stringify(store.items.get("root"))).not.toContain(token);
  });
});
