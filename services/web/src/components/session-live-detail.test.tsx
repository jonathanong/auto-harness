// @vitest-environment happy-dom

import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { TooltipProvider, type SessionSummary } from "@auto-harness/ui";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assignedHostIsOffline,
  fetchSessionLiveState,
  SessionLiveDetail,
} from "./session-live-detail.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const running: SessionSummary = { id: "session/one", status: "running", hostId: "host-one" };

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

describe("session live detail", () => {
  it("recognizes only a running session whose assigned host is explicitly offline", () => {
    expect(assignedHostIsOffline({ ...running, status: "queued" }, [])).toBe(false);
    expect(assignedHostIsOffline({ ...running, hostId: null }, [])).toBe(false);
    expect(assignedHostIsOffline(running, [])).toBe(false);
    expect(assignedHostIsOffline(running, [{ hostId: "host-one", online: true }])).toBe(false);
    expect(assignedHostIsOffline(running, [{ hostId: "host-one", online: false }])).toBe(true);
  });

  it("fetches hosts only for an assigned running session", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(true, running))
      .mockResolvedValueOnce(response(true, {}))
      .mockResolvedValueOnce(response(true, { ...running, status: "cancelled" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSessionLiveState("session/one")).resolves.toEqual({
      session: running,
      hosts: [],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/sessions/session%2Fone", {
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/hosts", {
      cache: "no-store",
      credentials: "same-origin",
    });
    await expect(fetchSessionLiveState("session/one")).resolves.toMatchObject({
      session: { status: "cancelled" },
      hosts: [],
    });
  });

  it("rejects a failed refresh", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(false, {})));
    await expect(fetchSessionLiveState("missing")).rejects.toThrow(
      "GET /api/v1/sessions/missing failed",
    );
  });

  it("shows the accessible offline warning and refreshes it away", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(true, running))
      .mockResolvedValueOnce(response(true, { items: [{ hostId: "host-one", online: true }] }));
    vi.stubGlobal("fetch", fetchMock);
    const view = mount(
      <SessionLiveDetail
        initialSession={running}
        initialHosts={[{ hostId: "host-one", online: false }]}
      >
        <p data-pw="child">child</p>
      </SessionLiveDetail>,
    );
    expect(
      view.container.querySelector('[data-pw="session-agent-offline"]')?.getAttribute("role"),
    ).toBe("alert");
    expect(view.container.querySelector('[data-pw="session-force-cancel"]')).not.toBeNull();
    expect(view.container.querySelector('[data-pw="child"]')).not.toBeNull();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.container.querySelector('[data-pw="session-agent-offline"]')).toBeNull();
    expect(view.container.querySelector('[data-pw="session-cancel"]')).not.toBeNull();
    view.unmount();
  });

  it("keeps the last state and reports a polling failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(false, {})));
    const view = mount(<SessionLiveDetail initialSession={running} initialHosts={[]} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      view.container.querySelector('[data-pw="session-live-state-error"]')?.textContent,
    ).toContain("refresh paused");
    view.unmount();
  });

  it("does not update after unmounting during an in-flight refresh", async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<ReturnType<typeof response>>((done) => (resolve = done))),
    );
    const view = mount(<SessionLiveDetail initialSession={running} initialHosts={[]} />);
    view.unmount();
    resolve(response(true, { ...running, status: "completed" }));
    await Promise.resolve();
  });

  it("waits for an in-flight refresh before scheduling the next poll", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    const view = mount(<SessionLiveDetail initialSession={running} initialHosts={[]} />);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(fetch).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
