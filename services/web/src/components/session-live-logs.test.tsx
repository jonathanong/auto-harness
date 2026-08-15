// @vitest-environment happy-dom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { field, mountForm, press } from "./form-test-helpers.tsx";
import { SessionLiveLogs } from "./session-live-logs.tsx";

vi.mock("./session-terminal-viewer.tsx", () => ({
  SessionTerminalViewer: ({ sessionId }: { sessionId: string }) => (
    <div data-pw="mock-terminal">{sessionId}</div>
  ),
}));

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
