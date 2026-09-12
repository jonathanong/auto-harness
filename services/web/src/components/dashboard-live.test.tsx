// @vitest-environment happy-dom
/* eslint-disable max-lines -- poll, retry, and overlap cases share one dashboard fixture. */

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardLive, type DashboardSnapshot } from "./dashboard-live.tsx";
import { createRequestFake, field, json, mountForm, press } from "./form-test-helpers.tsx";

afterEach(() => vi.useRealTimers());

const emptySnapshot: DashboardSnapshot = {
  sessions: [],
  hosts: [],
  worktrees: [],
  hostsAtLimit: false,
  worktreesAtLimit: false,
  running: { count: 0, atLimit: false },
  queued: { count: 0, atLimit: false },
};

describe("DashboardLive", () => {
  it("computes utilization and replaces the bounded snapshot on a poll", async () => {
    vi.useFakeTimers();
    const request = createRequestFake(
      json({ items: [{ id: "new", status: "running" }] }),
      json({ items: [{ hostId: "host-1", online: true }] }),
      json({
        items: [
          { id: "busy", online: true, status: "busy" },
          { id: "idle", online: true, status: "idle" },
          { id: "offline", online: false, status: "busy" },
        ],
      }),
      json({ items: [{ id: "new" }], nextCursor: null }),
      json({ items: [], nextCursor: null }),
    );
    vi.stubGlobal("fetch", request.request);
    const view = mountForm(<DashboardLive initial={emptySnapshot} pollMs={10} />);
    expect(field(view.container, "dashboard-no-online-hosts")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(field(view.container, "stat-running-value").textContent).toBe("1");
    expect(field(view.container, "stat-queued-value").textContent).toBe("0");
    expect(field(view.container, "stat-worktree-utilization-value").textContent).toBe("1/2 busy");
    expect(field(view.container, "stat-worktree-utilization-detail").textContent).toBe(
      "1 offline or unavailable",
    );
    expect(view.container.querySelector('[data-pw="dashboard-no-online-hosts"]')).toBeNull();
    expect(request.requests.map(([input]) => String(input))).toEqual([
      "/api/v1/sessions?limit=50",
      "/api/v1/hosts?limit=100",
      "/api/v1/worktrees?limit=100",
      "/api/v1/sessions?status=running&limit=100",
      "/api/v1/sessions?status=queued&limit=100",
    ]);
  });

  it("shows a '100+' bound instead of a false-precise count once a status hits the server limit", async () => {
    vi.useFakeTimers();
    const request = createRequestFake(
      json({ items: [] }),
      json({ items: [] }),
      json({ items: [] }),
      json({
        items: Array.from({ length: 100 }, (_, i) => ({ id: `r-${i}` })),
        nextCursor: "more",
      }),
      json({ items: [], nextCursor: null }),
    );
    vi.stubGlobal("fetch", request.request);
    const view = mountForm(<DashboardLive initial={emptySnapshot} pollMs={10} />);
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(field(view.container, "stat-running-value").textContent).toBe("100+");
    expect(field(view.container, "stat-queued-value").textContent).toBe("0");
  });

  it("marks host and worktree totals as lower bounds when a nextCursor is present", async () => {
    vi.useFakeTimers();
    const request = createRequestFake(
      json({ items: [] }),
      json({
        items: Array.from({ length: 100 }, (_, i) => ({ hostId: `h-${i}`, online: true })),
        nextCursor: "more-hosts",
      }),
      json({
        items: Array.from({ length: 100 }, (_, i) => ({
          id: `wt-${i}`,
          online: true,
          status: "idle",
        })),
        nextCursor: "more-worktrees",
      }),
      json({ items: [], nextCursor: null }),
      json({ items: [], nextCursor: null }),
    );
    vi.stubGlobal("fetch", request.request);
    const view = mountForm(<DashboardLive initial={emptySnapshot} pollMs={10} />);
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(field(view.container, "stat-hosts-online-value").textContent).toBe("100/100+");
    expect(field(view.container, "stat-worktree-utilization-value").textContent).toBe(
      "0/100+ busy",
    );
  });

  it("keeps the last snapshot on failure and retries manually", async () => {
    vi.useFakeTimers();
    const request = createRequestFake(
      () => Promise.reject(new Error("offline")),
      json({ items: [] }),
      json({ items: [] }),
      json({ items: [], nextCursor: null }),
      json({ items: [], nextCursor: null }),
      json({ items: [{ id: "recovered", status: "queued" }] }),
      json({ items: [] }),
      json({ items: [] }),
      json({ items: [], nextCursor: null }),
      json({ items: [{ id: "recovered" }], nextCursor: null }),
    );
    vi.stubGlobal("fetch", request.request);
    const view = mountForm(
      <DashboardLive
        initial={{
          sessions: [{ id: "old", status: "running" }],
          hosts: [],
          worktrees: [],
          hostsAtLimit: false,
          worktreesAtLimit: false,
          running: { count: 1, atLimit: false },
          queued: { count: 0, atLimit: false },
        }}
        pollMs={10}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(field(view.container, "live-updates-paused").textContent).toContain("offline");
    expect(field(view.container, "stat-running-value").textContent).toBe("1");
    await act(async () =>
      press(field(view.container, "live-updates-paused").querySelector("button")!),
    );
    expect(field(view.container, "stat-queued-value").textContent).toBe("1");
    expect(field(view.container, "live-updates-active")).toBeTruthy();
  });

  it("does not overlap slow dashboard polls", async () => {
    vi.useFakeTimers();
    let resolveSessions!: (response: Response) => void;
    const sessions = new Promise<Response>((resolve) => {
      resolveSessions = resolve;
    });
    const request = createRequestFake(
      sessions,
      json({ items: [] }),
      json({ items: [] }),
      json({ items: [], nextCursor: null }),
      json({ items: [], nextCursor: null }),
      json({ items: [] }),
      json({ items: [] }),
      json({ items: [] }),
      json({ items: [], nextCursor: null }),
      json({ items: [], nextCursor: null }),
    );
    vi.stubGlobal("fetch", request.request);
    mountForm(<DashboardLive initial={emptySnapshot} pollMs={10} />);

    await act(async () => vi.advanceTimersByTimeAsync(10));
    await act(async () => vi.advanceTimersByTimeAsync(30));
    expect(request.requests).toHaveLength(5);
    await act(async () => {
      resolveSessions(json({ items: [] }));
      await sessions;
    });
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(request.requests).toHaveLength(10);
  });

  it("stringifies a non-Error poll rejection", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => {
      throw "dashboard-offline";
    });
    const view = mountForm(<DashboardLive initial={emptySnapshot} pollMs={10} />);
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(field(view.container, "live-updates-paused").textContent).toContain("dashboard-offline");
  });

  it("ignores a second retry while a dashboard refresh is already in flight", async () => {
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches += 1;
      return await new Promise<Response>(() => undefined);
    });
    const view = mountForm(
      <DashboardLive initial={emptySnapshot} initialError="paused" pollMs={60_000} />,
    );
    const retryButton = field(view.container, "live-updates-paused").querySelector("button")!;
    await act(async () => press(retryButton));
    expect(fetches).toBeGreaterThan(0);
    const inFlight = fetches;
    await act(async () => press(retryButton));
    expect(fetches).toBe(inFlight);
    view.unmount();
  });

  it("does not arm the next poll when unmounted during refresh", async () => {
    vi.useFakeTimers();
    let resolveSessions!: (response: Response) => void;
    const sessions = new Promise<Response>((resolve) => {
      resolveSessions = resolve;
    });
    const request = createRequestFake(
      sessions,
      json({ items: [] }),
      json({ items: [] }),
      json({ items: [], nextCursor: null }),
      json({ items: [], nextCursor: null }),
    );
    vi.stubGlobal("fetch", request.request);
    const view = mountForm(<DashboardLive initial={emptySnapshot} pollMs={10} />);
    await act(async () => vi.advanceTimersByTimeAsync(10));
    view.unmount();
    await act(async () => {
      resolveSessions(json({ items: [] }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(request.requests.length).toBeLessThanOrEqual(5);
  });

  it("does not schedule another poll after unmount", async () => {
    vi.useFakeTimers();
    const request = createRequestFake(
      json({ items: [] }),
      json({ items: [] }),
      json({ items: [] }),
      json({ items: [], nextCursor: null }),
      json({ items: [], nextCursor: null }),
    );
    vi.stubGlobal("fetch", request.request);
    const view = mountForm(<DashboardLive initial={emptySnapshot} pollMs={10} />);
    await act(async () => vi.advanceTimersByTimeAsync(10));
    const inFlight = request.requests.length;
    view.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(request.requests).toHaveLength(inFlight);
  });
});
