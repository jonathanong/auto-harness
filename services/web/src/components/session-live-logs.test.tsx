// @vitest-environment happy-dom
/* eslint-disable max-lines -- live poll, viewer notify, and unmount races share one fixture. */

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SESSION_QUEUED_WAIT_COPY } from "@auto-harness/ui";

import { field, mountForm } from "../../test-helpers/form-test-helpers.tsx";
import { SessionLiveLogs } from "./session-live-logs.tsx";

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SessionLiveLogs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("polls REST logs and notes the S3 delay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/logs")
          ? Response.json({
              items: [
                {
                  timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
                  seq: 1,
                  stream: "stdout",
                  content: "hello",
                  timestamp: "2026-01-01T00:00:00.000Z",
                },
              ],
            })
          : Response.json({ status: "completed" }),
      ),
    );
    const view = mountForm(
      <SessionLiveLogs sessionId="session-1" initialItems={[]} initialStatus="running" />,
    );
    await settle();
    await settle();
    expect(field(view.container, "session-logs-s3-note").textContent).toContain("host pane");
    expect(field(view.container, "session-logs-live-state").textContent).toBe("completed");
    expect(vi.mocked(fetch)).toHaveBeenCalled();
    view.unmount();
  });

  it("shows queued wait copy and a poll error, then refetches on log-part notify", async () => {
    const sockets: FakeWebSocket[] = [];
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      sent: string[] = [];
      private readonly listeners = new Map<string, Array<(event: Event) => void>>();
      constructor(public url: string) {
        sockets.push(this);
      }
      addEventListener(type: string, handler: (event: Event) => void) {
        const list = this.listeners.get(type) ?? [];
        list.push(handler);
        this.listeners.set(type, list);
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {
        this.readyState = 3;
      }
      emit(type: string, event: Event) {
        for (const handler of this.listeners.get(type) ?? []) handler(event);
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let allowLogs = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        const path = String(url);
        if (path.includes("session-log-settings")) {
          return Response.json({ controlPlanePollMs: 5_000 });
        }
        if (path.includes("viewer-ticket")) {
          return Response.json({ ticket: "ticket" });
        }
        if (path.includes("/logs")) {
          if (!allowLogs) return new Response(null, { status: 500 });
          return Response.json({
            items: [
              {
                timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
                seq: 1,
                stream: "stdout",
                content: "hello",
                timestamp: "2026-01-01T00:00:00.000Z",
              },
            ],
          });
        }
        if (init?.method === "POST") return Response.json({ ticket: "ticket" });
        return Response.json({ status: "queued" });
      }),
    );
    const view = mountForm(
      <SessionLiveLogs sessionId="session-1" initialItems={[]} initialStatus="queued" />,
    );
    await settle();
    await settle();
    expect(view.container.textContent).toContain(SESSION_QUEUED_WAIT_COPY);
    expect(field(view.container, "session-logs-live-error").textContent).toContain("unavailable");
    const socket = sockets[0];
    expect(socket).toBeTruthy();
    allowLogs = true;
    await act(async () => {
      socket!.emit("open", new Event("open"));
      socket!.emit(
        "message",
        new MessageEvent("message", { data: JSON.stringify({ type: "session:log-part" }) }),
      );
      socket!.emit("message", new MessageEvent("message", { data: "not-json" }));
    });
    await settle();
    view.unmount();
    expect(socket!.sent.some((frame) => frame.includes("unsubscribe"))).toBe(true);
  });

  it("ignores a failed settings fetch and a failed log-part refetch", async () => {
    const sockets: Array<{
      onMessage?: (event: Event) => void;
      emit(type: string, event: Event): void;
    }> = [];
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      onMessage: ((event: Event) => void) | undefined;
      constructor(public url: string) {
        sockets.push(this);
      }
      addEventListener(type: string, handler: (event: Event) => void) {
        if (type === "message") this.onMessage = handler;
      }
      emit(_type: string, event: Event) {
        this.onMessage?.(event);
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url);
        if (path.includes("session-log-settings")) throw new Error("offline");
        if (path.includes("viewer-ticket")) return Response.json({ ticket: "ticket" });
        if (path.includes("/logs")) throw new Error("refetch failed");
        return Response.json({ status: "running" });
      }),
    );
    const view = mountForm(
      <SessionLiveLogs sessionId="session-1" initialItems={[]} initialStatus="running" />,
    );
    await settle();
    await settle();
    await act(async () => {
      sockets[0]?.emit(
        "message",
        new MessageEvent("message", { data: JSON.stringify({ type: "session:log-part" }) }),
      );
      sockets[0]?.emit("message", new MessageEvent("message", { data: "{" }));
    });
    await settle();
    view.unmount();
  });

  it("ignores in-flight polls after unmount and non-array log pages", async () => {
    let releaseLogs!: () => void;
    const logsGate = new Promise<void>((resolve) => {
      releaseLogs = resolve;
    });
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    let releaseTicket!: () => void;
    const ticketGate = new Promise<void>((resolve) => {
      releaseTicket = resolve;
    });
    const sockets: Array<{ emit(type: string, event: Event): void }> = [];
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      private readonly listeners = new Map<string, Array<(event: Event) => void>>();
      constructor(public url: string) {
        sockets.push(this);
      }
      addEventListener(type: string, handler: (event: Event) => void) {
        const list = this.listeners.get(type) ?? [];
        list.push(handler);
        this.listeners.set(type, list);
      }
      emit(type: string, event: Event) {
        for (const handler of this.listeners.get(type) ?? []) handler(event);
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let failLogs = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url);
        if (path.includes("session-log-settings")) return new Response(null, { status: 500 });
        if (path.includes("viewer-ticket")) {
          await ticketGate;
          return Response.json({ ticket: "ticket" });
        }
        if (path.includes("/logs")) {
          await logsGate;
          return failLogs ? new Response(null, { status: 500 }) : Response.json({ items: "nope" });
        }
        await statusGate;
        return Response.json({ status: 1 });
      }),
    );
    const first = mountForm(
      <SessionLiveLogs sessionId="session-1" initialItems={[]} initialStatus="running" />,
    );
    await settle();
    first.unmount();
    releaseLogs();
    releaseStatus();
    releaseTicket();
    await settle();
    const view = mountForm(
      <SessionLiveLogs sessionId="session-1" initialItems={[]} initialStatus="running" />,
    );
    await settle();
    await settle();
    failLogs = true;
    await act(async () => {
      sockets
        .at(-1)
        ?.emit(
          "message",
          new MessageEvent("message", { data: JSON.stringify({ type: "session:log-part" }) }),
        );
    });
    await settle();
    view.unmount();
  });

  it("ignores a rejected viewer ticket and skips unsubscribe when the socket is not open", async () => {
    const sockets: Array<{ readyState: number; sent: string[]; close(): void }> = [];
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 0;
      sent: string[] = [];
      constructor(public url: string) {
        sockets.push(this);
      }
      addEventListener() {}
      send(data: string) {
        this.sent.push(data);
      }
      close() {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url);
        if (path.includes("viewer-ticket")) throw new Error("ticket down");
        if (path.includes("session-log-settings")) return Response.json({});
        if (path.includes("/logs")) return Response.json({ items: [] });
        return Response.json({ status: "running" });
      }),
    );
    const view = mountForm(
      <SessionLiveLogs sessionId="session-1" initialItems={[]} initialStatus="running" />,
    );
    await settle();
    await settle();
    expect(sockets).toHaveLength(0);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url);
        if (path.includes("viewer-ticket")) return Response.json({ ticket: "ticket" });
        if (path.includes("session-log-settings")) return Response.json({});
        if (path.includes("/logs")) return Response.json({ items: [] });
        return Response.json({ status: "running" });
      }),
    );
    const openLater = mountForm(
      <SessionLiveLogs sessionId="session-2" initialItems={[]} initialStatus="running" />,
    );
    await settle();
    await settle();
    expect(sockets.at(-1)?.readyState).toBe(0);
    openLater.unmount();
    expect(sockets.at(-1)?.sent).toEqual([]);
    view.unmount();
  });

  it("drops in-flight log and status polls after unmount and a failed log-part refetch", async () => {
    let releaseLogs!: () => void;
    const logsGate = new Promise<void>((resolve) => {
      releaseLogs = resolve;
    });
    const statusTimers: Array<() => void> = [];
    const realSetTimeout = setTimeout;
    vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => {
      if (ms === 2_000) {
        statusTimers.push(fn);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);
    const sockets: Array<{ emit(type: string, event: Event): void }> = [];
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      private readonly listeners = new Map<string, Array<(event: Event) => void>>();
      constructor(public url: string) {
        sockets.push(this);
      }
      addEventListener(type: string, handler: (event: Event) => void) {
        const list = this.listeners.get(type) ?? [];
        list.push(handler);
        this.listeners.set(type, list);
      }
      emit(type: string, event: Event) {
        for (const handler of this.listeners.get(type) ?? []) handler(event);
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url);
        if (path.includes("viewer-ticket")) return Response.json({ ticket: "ticket" });
        if (path.includes("session-log-settings")) return Response.json({});
        if (path.includes("/logs")) {
          await logsGate;
          return new Response(null, { status: 500 });
        }
        return Response.json({ status: "running" });
      }),
    );
    const first = mountForm(
      <SessionLiveLogs sessionId="session-1" initialItems={[]} initialStatus="running" />,
    );
    await settle();
    first.unmount();
    releaseLogs();
    for (const timer of statusTimers) timer();
    await settle();
    const view = mountForm(
      <SessionLiveLogs sessionId="session-2" initialItems={[]} initialStatus="running" />,
    );
    await settle();
    await settle();
    await act(async () => {
      sockets
        .at(-1)
        ?.emit(
          "message",
          new MessageEvent("message", { data: JSON.stringify({ type: "session:log-part" }) }),
        );
    });
    await settle();
    view.unmount();
  });

  it("does not apply a log poll that finishes after unmount", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let logsCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url);
        if (path.includes("/logs")) {
          logsCalls += 1;
          await gate;
          return Response.json({
            items: [
              {
                timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
                seq: 1,
                stream: "stdout",
                content: "late",
                timestamp: "2026-01-01T00:00:00.000Z",
              },
            ],
          });
        }
        if (path.includes("viewer-ticket")) return Response.json({ ticket: "ticket" });
        return Response.json({ status: "running" });
      }),
    );
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      addEventListener() {}
      send() {}
      close() {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const view = mountForm(
      <SessionLiveLogs sessionId="session-1" initialItems={[]} initialStatus="running" />,
    );
    await expect.poll(() => logsCalls).toBeGreaterThan(0);
    view.unmount();
    release();
    await settle();
    await settle();
  });

  it("ignores a non-ok log-part refetch while still mounted", async () => {
    const sockets: Array<{ emit(type: string, event: Event): void }> = [];
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      private readonly listeners = new Map<string, Array<(event: Event) => void>>();
      constructor(public url: string) {
        sockets.push(this);
      }
      addEventListener(type: string, handler: (event: Event) => void) {
        const list = this.listeners.get(type) ?? [];
        list.push(handler);
        this.listeners.set(type, list);
      }
      emit(type: string, event: Event) {
        for (const handler of this.listeners.get(type) ?? []) handler(event);
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url);
        if (path.includes("viewer-ticket")) return Response.json({ ticket: "ticket" });
        if (path.includes("session-log-settings")) return Response.json({});
        if (path.includes("/logs")) return new Response(null, { status: 503 });
        return Response.json({ status: "running" });
      }),
    );
    const view = mountForm(
      <SessionLiveLogs sessionId="session-1" initialItems={[]} initialStatus="running" />,
    );
    await settle();
    await settle();
    expect(sockets[0]).toBeTruthy();
    await act(async () => {
      sockets[0]!.emit(
        "message",
        new MessageEvent("message", { data: JSON.stringify({ type: "session:log-part" }) }),
      );
    });
    await settle();
    view.unmount();
  });
});
