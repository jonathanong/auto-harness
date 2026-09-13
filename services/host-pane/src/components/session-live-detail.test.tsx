// @vitest-environment happy-dom

import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { TooltipProvider, type SessionSummary } from "@auto-harness/ui";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSessionLiveState, SessionLiveDetail } from "./session-live-detail.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const queued: SessionSummary = {
  id: "session/one",
  status: "queued",
  queueExpiresAt: "2026-08-14T12:30:00.000Z",
};

function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        AppRouterContext.Provider,
        { value: { push: vi.fn(), refresh: vi.fn() } as never },
        createElement(TooltipProvider, null, node),
      ),
    );
  });
  return { container, unmount: () => act(() => root.unmount()) };
}

function response(ok: boolean, body: unknown) {
  return { ok, json: vi.fn(async () => body) };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("host session live detail", () => {
  it("fetches the same-origin session and rejects a failed refresh", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(true, queued))
      .mockResolvedValueOnce(response(false, {}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSessionLiveState("session/one")).resolves.toEqual(queued);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/sessions/session%2Fone", {
      cache: "no-store",
      credentials: "same-origin",
    });
    await expect(fetchSessionLiveState("missing")).rejects.toThrow(
      "GET /api/v1/sessions/missing failed",
    );
  });

  it("refreshes a queued detail to terminal state and removes its deadline", async () => {
    vi.useFakeTimers();
    const completed = { ...queued, status: "completed" };
    const archive = { state: "dynamodb" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/archive")) return response(true, archive);
      return response(true, completed);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = mount(
      <SessionLiveDetail initialSession={queued}>
        <p data-pw="child">child</p>
      </SessionLiveDetail>,
    );
    expect(
      view.container.querySelector('[data-pw="session-detail-queue-deadline"]'),
    ).not.toBeNull();
    expect(view.container.querySelector('[data-pw="session-archive"]')).toBeNull();
    expect(view.container.querySelector('[data-pw="child"]')).not.toBeNull();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.container.querySelector('[data-pw="session-detail-queue-deadline"]')).toBeNull();
    expect(view.container.querySelector('[data-pw="session-resume"]')).not.toBeNull();
    expect(view.container.querySelector('[data-pw="session-archive"]')).not.toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/archive"))).toBe(true);
    expect(view.container.querySelector('[data-pw="session-archive-error"]')).toBeNull();
    expect(
      view.container.querySelector('[data-pw="session-archive-state"]')?.textContent,
    ).toContain("not archived");
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("schedules another poll after a successful non-terminal refresh", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(true, { ...queued, status: "running" })),
    );
    const view = mount(<SessionLiveDetail initialSession={queued} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the last state, reports a failure, and schedules a retry", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(response(false, {})).mockResolvedValue(response(false, {})),
    );
    const view = mount(<SessionLiveDetail initialSession={queued} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      view.container.querySelector('[data-pw="session-live-state-error"]')?.textContent,
    ).toContain("refresh paused");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
  });

  it("does not update after unmounting during a successful refresh", async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<ReturnType<typeof response>>((done) => (resolve = done))),
    );
    const view = mount(<SessionLiveDetail initialSession={queued} />);
    view.unmount();
    resolve(response(true, { ...queued, status: "running" }));
    await Promise.resolve();
  });

  it("does not update or schedule after unmounting during a failed refresh", async () => {
    vi.useFakeTimers();
    let reject!: (reason: Error) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<ReturnType<typeof response>>((_done, fail) => {
            reject = fail;
          }),
      ),
    );
    const view = mount(<SessionLiveDetail initialSession={queued} />);
    view.unmount();
    reject(new Error("refresh failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps archive 401 as a local error without a control-plane login redirect", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", {
      ...window,
      location: { pathname: "/sessions/session%2Fone", search: "", assign },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        if (String(input).includes("/archive")) {
          return { ok: false, status: 401, json: async () => ({}) };
        }
        return response(true, { ...queued, status: "completed" });
      }),
    );
    const view = mount(<SessionLiveDetail initialSession={{ ...queued, status: "completed" }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(assign).not.toHaveBeenCalled();
    expect(
      view.container.querySelector('[data-pw="session-archive-error"]')?.textContent,
    ).toContain("could not");
    view.unmount();
  });
});
