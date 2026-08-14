// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionDetailTiming } from "./session-detail-timing.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const now = Date.parse("2026-08-12T12:02:03.000Z");

function mount(props: Partial<React.ComponentProps<typeof SessionDetailTiming>> = {}) {
  const container = document.createElement("dl");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <SessionDetailTiming
        status="completed"
        initialNow={now}
        createdAt="2026-08-12T11:59:00.000Z"
        startedAt="2026-08-12T12:00:00.000Z"
        completedAt="2026-08-12T12:02:03.000Z"
        {...props}
      />,
    ),
  );
  return { container, root };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("SessionDetailTiming", () => {
  it("uses the system clock when initialNow is omitted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const view = mount({ initialNow: undefined, status: "running", completedAt: null });
    expect(view.container.querySelector('[data-pw="session-detail-duration"]')?.textContent).toBe(
      "2m 3s",
    );
    act(() => view.root.unmount());
  });

  it("shows exact readable timestamps and a terminal duration", () => {
    const view = mount();
    expect(
      view.container.querySelector('[data-pw="session-detail-created"] time')?.textContent,
    ).toBe("Aug 12, 2026, 11:59:00 AM");
    expect(view.container.querySelector("time")?.title).toBe("2026-08-12T11:59:00.000Z");
    expect(view.container.querySelector('[data-pw="session-detail-duration"]')?.textContent).toBe(
      "2m 3s",
    );
    expect(
      view.container
        .querySelector('[data-pw="session-detail-duration"]')
        ?.hasAttribute("aria-live"),
    ).toBe(false);
    act(() => view.root.unmount());
  });

  it("ticks a running duration once per second and cleans up", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const view = mount({ status: "running", completedAt: null });
    expect(view.container.querySelector('[data-pw="session-detail-duration"]')?.textContent).toBe(
      "2m 3s",
    );
    act(() => vi.advanceTimersByTime(1_000));
    expect(view.container.querySelector('[data-pw="session-detail-duration"]')?.textContent).toBe(
      "2m 4s",
    );
    act(() => view.root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    const skew = mount({
      status: "running",
      startedAt: "2026-08-12T12:03:00.000Z",
      completedAt: null,
    });
    expect(skew.container.querySelector('[data-pw="session-detail-duration"]')?.textContent).toBe(
      "0s",
    );
    act(() => skew.root.unmount());
  });

  it("handles hours, clock skew, active non-running, and invalid timestamps", () => {
    const hours = mount({
      startedAt: "2026-08-12T09:00:00.000Z",
      completedAt: "2026-08-12T11:02:03.000Z",
    });
    expect(hours.container.querySelector('[data-pw="session-detail-duration"]')?.textContent).toBe(
      "2h 2m 3s",
    );
    act(() => hours.root.unmount());
    const skew = mount({
      startedAt: "2026-08-12T12:01:00.000Z",
      completedAt: "2026-08-12T12:00:00.000Z",
    });
    expect(skew.container.querySelector('[data-pw="session-detail-duration"]')?.textContent).toBe(
      "0s",
    );
    act(() => skew.root.unmount());
    const absent = mount({
      createdAt: "invalid",
      startedAt: null,
      completedAt: null,
      status: "queued",
    });
    expect(absent.container.querySelector('[data-pw="session-detail-created"]')?.textContent).toBe(
      "—",
    );
    expect(absent.container.querySelector('[data-pw="session-detail-duration"]')?.textContent).toBe(
      "—",
    );
    act(() => absent.root.unmount());
    const incomplete = mount({ completedAt: "invalid", status: "completed" });
    expect(
      incomplete.container.querySelector('[data-pw="session-detail-duration"]')?.textContent,
    ).toBe("—");
    act(() => incomplete.root.unmount());
    const active = mount({ completedAt: "2026-08-12T12:02:03.000Z", status: "queued" });
    expect(active.container.querySelector('[data-pw="session-detail-duration"]')?.textContent).toBe(
      "—",
    );
    act(() => active.root.unmount());
  });

  it("formats sub-minute terminal durations", () => {
    const view = mount({
      startedAt: "2026-08-12T12:00:00.000Z",
      completedAt: "2026-08-12T12:00:42.000Z",
    });
    expect(view.container.querySelector('[data-pw="session-detail-duration"]')?.textContent).toBe(
      "42s",
    );
    act(() => view.root.unmount());
  });
});
