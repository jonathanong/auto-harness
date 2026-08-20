// @vitest-environment happy-dom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SESSION_QUEUED_WAIT_COPY } from "@auto-harness/ui";

import { field, mountForm, press } from "./form-test-helpers.tsx";
import { SessionLiveLogs } from "./session-live-logs.tsx";

type Handler = (event: { code?: number; data?: string }) => void;

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  handlers = new Map<string, Handler[]>();
  send = vi.fn();
  close = vi.fn();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: Handler) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  emit(type: string, event: { code?: number; data?: string } = {}) {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function emitStatus(socket: FakeWebSocket, type: string, status: string) {
  act(() =>
    socket.emit("message", {
      data: JSON.stringify({ type, status }),
    }),
  );
}

afterEach(() => {
  document.body.replaceChildren();
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
});

describe("SessionLiveLogs reconnect controls", () => {
  it("announces a closed connection and reconnects immediately on request", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ticket: "ticket" }) }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const view = mountForm(
      <SessionLiveLogs sessionId="session-1" initialItems={[]} initialStatus="running" />,
    );
    await settle();
    const first = FakeWebSocket.instances[0]!;
    act(() => first.emit("open"));
    expect(first.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
    );
    act(() =>
      first.emit("message", {
        data: JSON.stringify({ type: "session:subscribed", status: "running" }),
      }),
    );
    expect(field(view.container, "session-logs-live-state").textContent).toContain("Live");

    act(() => first.emit("close", { code: 1006 }));
    expect(field(view.container, "session-logs-reconnect-banner").textContent).toContain(
      "Real-time updates paused",
    );
    press(field(view.container, "session-logs-reconnect-now"));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(2);
    view.unmount();
  });

  it("offers immediate reconnect while viewer-ticket retry is waiting", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const view = mountForm(
      <SessionLiveLogs sessionId="session-2" initialItems={[]} initialStatus="queued" />,
    );
    await settle();
    press(field(view.container, "session-logs-reconnect-now"));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances[0]?.url).not.toContain("ticket=");
    view.unmount();
  });
});

describe("SessionLiveLogs status display", () => {
  async function mountLive(sessionId: string, initialStatus: string) {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ticket: "ticket" }) }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const view = mountForm(
      <SessionLiveLogs sessionId={sessionId} initialItems={[]} initialStatus={initialStatus} />,
    );
    await settle();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.emit("open"));
    return { view, socket };
  }

  it("keeps a terminal initialStatus when subscribe reports queued", async () => {
    const { view, socket } = await mountLive("session-done", "completed");
    emitStatus(socket, "session:subscribed", "queued");
    const state = field(view.container, "session-logs-live-state").textContent;
    expect(state).toBe("completed");
    expect(state).not.toContain("Live —");
    expect(view.container.textContent).not.toContain(SESSION_QUEUED_WAIT_COPY);
    view.unmount();
  });

  it("keeps a terminal initialStatus when subscribe reports running", async () => {
    const { view, socket } = await mountLive("session-done-running", "completed");
    emitStatus(socket, "session:subscribed", "running");
    const state = field(view.container, "session-logs-live-state").textContent;
    expect(state).toBe("completed");
    expect(state).not.toContain("Live —");
    view.unmount();
  });

  it("does not label a later terminal session Live", async () => {
    const { view, socket } = await mountLive("session-run", "running");
    emitStatus(socket, "session:subscribed", "running");
    expect(field(view.container, "session-logs-live-state").textContent).toBe("Live — running");
    emitStatus(socket, "session:status", "completed");
    expect(field(view.container, "session-logs-live-state").textContent).toBe("completed");
    view.unmount();
  });

  it("explains that queued sessions wait for the one-minute scheduler", async () => {
    const { view, socket } = await mountLive("session-wait", "queued");
    emitStatus(socket, "session:subscribed", "queued");
    expect(field(view.container, "session-logs-live-state").textContent).toBe("Live — queued");
    expect(view.container.textContent).toContain(SESSION_QUEUED_WAIT_COPY);
    view.unmount();
  });

  it("ignores a stale queued status after the session has finished", async () => {
    const { view, socket } = await mountLive("session-stale", "failed");
    emitStatus(socket, "session:subscribed", "failed");
    emitStatus(socket, "session:status", "queued");
    expect(field(view.container, "session-logs-live-state").textContent).toBe("failed");
    expect(view.container.textContent).not.toContain(SESSION_QUEUED_WAIT_COPY);
    view.unmount();
  });
});
