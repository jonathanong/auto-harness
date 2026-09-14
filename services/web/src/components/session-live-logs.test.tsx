// @vitest-environment happy-dom

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
    expect(field(view.container, "session-logs-live-state").textContent).toContain("queued");
    view.unmount();
  });
});
