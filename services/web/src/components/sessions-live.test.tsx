// @vitest-environment happy-dom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionsLive } from "./sessions-live.tsx";
import { createRequestFake, field, json, mountForm, press } from "./form-test-helpers.tsx";

afterEach(() => vi.useRealTimers());

describe("SessionsLive", () => {
  it("polls the bounded current page and updates session rows", async () => {
    vi.useFakeTimers();
    const request = createRequestFake(json({ items: [{ id: "live", status: "running" }] }));
    vi.stubGlobal("fetch", request.request);
    const view = mountForm(
      <SessionsLive
        initialItems={[]}
        path="/api/v1/sessions?status=running"
        nextHref={null}
        prevHref={null}
        search=""
        pollMs={10}
      />,
    );
    expect(view.container.textContent).toContain("No sessions yet");
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(field(view.container, "session-row-live")).toBeTruthy();
    expect(String(request.requests[0]?.[0])).toBe("/api/v1/sessions?status=running");
  });

  it("shows a paused state, retains rows, and recovers on retry", async () => {
    vi.useFakeTimers();
    const request = createRequestFake(
      new Response(null, { status: 503 }),
      json({ items: [{ id: "fresh", status: "completed" }] }),
    );
    vi.stubGlobal("fetch", request.request);
    const view = mountForm(
      <SessionsLive
        initialItems={[{ id: "old", status: "queued" }]}
        path="/api/v1/sessions"
        nextHref={null}
        prevHref={null}
        search=""
        pollMs={10}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(field(view.container, "sessions-live-error")).toBeTruthy();
    expect(field(view.container, "session-row-old")).toBeTruthy();
    await act(async () =>
      press(field(view.container, "sessions-live-error").querySelector("button")!),
    );
    expect(field(view.container, "session-row-fresh")).toBeTruthy();
    expect(field(view.container, "sessions-live-active")).toBeTruthy();
  });
});
