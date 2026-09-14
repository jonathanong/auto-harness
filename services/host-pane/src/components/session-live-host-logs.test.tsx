// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionLiveHostLogs } from "./session-live-host-logs.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Set<(event: Event) => void>>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, handler: (event: Event) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, handler: (event: Event) => void) {
    this.listeners.get(type)?.delete(handler);
  }
  close() {}
  emit(type: string, event: Event) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

describe("SessionLiveHostLogs", () => {
  afterEach(() => {
    FakeEventSource.instances = [];
    vi.unstubAllGlobals();
  });

  it("appends daemon SSE chunks to the live banner", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <SessionLiveHostLogs
          sessionId="s1"
          initialItems={[
            {
              timestampSeq: "2026-01-01T00:00:00.000Z#0000000000000001",
              seq: 1,
              stream: "stdout",
              content: "seed",
              timestamp: "2026-01-01T00:00:00.000Z",
            },
          ]}
        />,
      );
    });
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toContain("/live-logs/s1");
    await act(async () => {
      source.emit("open", new Event("open"));
      source.emit(
        "message",
        new MessageEvent("message", {
          data: JSON.stringify({
            seq: 2,
            stream: "stdout",
            content: "hello",
            timestamp: "2026-01-01T00:00:01.000Z",
          }),
        }),
      );
    });
    expect(
      container.querySelector('[data-pw="session-logs-host-live-state"]')?.textContent,
    ).toContain("Live PTY");
    act(() => root.unmount());
    container.remove();
  });
});
