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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(true, { ...queued, status: "completed" })),
    );
    const view = mount(
      <SessionLiveDetail initialSession={queued}>
        <p data-pw="child">child</p>
      </SessionLiveDetail>,
    );
    expect(
      view.container.querySelector('[data-pw="session-detail-queue-deadline"]'),
    ).not.toBeNull();
    expect(view.container.querySelector('[data-pw="child"]')).not.toBeNull();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.container.querySelector('[data-pw="session-detail-queue-deadline"]')).toBeNull();
    expect(view.container.querySelector('[data-pw="session-resume"]')).not.toBeNull();
    view.unmount();
  });

  it("keeps the last state, reports a failure, and schedules a retry", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(false, {})));
    const view = mount(<SessionLiveDetail initialSession={queued} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      view.container.querySelector('[data-pw="session-live-state-error"]')?.textContent,
    ).toContain("refresh paused");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
  });

  it("does not update or schedule after unmounting during a refresh", async () => {
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
});
