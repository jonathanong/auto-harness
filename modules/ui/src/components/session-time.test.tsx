// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatDuration,
  formatRelativeTime,
  RelativeTime,
  sessionDurationMs,
} from "./session-time.tsx";
import { type SessionRow, SessionsTable } from "./sessions-table.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-08-12T12:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("session list times", () => {
  it("formats relative times and durations across valid and defensive inputs", () => {
    expect(formatRelativeTime("invalid", NOW)).toBeNull();
    expect(formatRelativeTime("2026-08-12T11:59:30.000Z", NOW)).toBe("30 seconds ago");
    expect(formatRelativeTime("2026-08-12T12:02:00.000Z", NOW)).toBe("in 2 minutes");
    expect(formatRelativeTime("2026-08-12T10:00:00.000Z", NOW)).toBe("2 hours ago");
    expect(formatRelativeTime("2026-08-10T12:00:00.000Z", NOW)).toBe("2 days ago");
    expect(formatDuration(9_000)).toBe("9s");
    expect(formatDuration(69_000)).toBe("1m 9s");
    expect(formatDuration(3_669_000)).toBe("1h 1m 9s");
    expect(sessionDurationMs({ status: "running", startedAt: "invalid" }, NOW)).toBeNull();
    expect(
      sessionDurationMs({ status: "completed", startedAt: "2026-08-12T11:00:00.000Z" }, NOW),
    ).toBeNull();
    expect(
      sessionDurationMs(
        {
          status: "queued",
          startedAt: "2026-08-12T11:00:00.000Z",
          completedAt: "2026-08-12T11:30:00.000Z",
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      sessionDurationMs(
        {
          status: "failed",
          startedAt: "2026-08-12T11:00:01.000Z",
          completedAt: "2026-08-12T11:00:00.000Z",
        },
        NOW,
      ),
    ).toBe(0);
  });

  it("ticks running duration once per second and keeps terminal duration fixed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const items: SessionRow[] = [
      {
        id: "running",
        status: "running",
        createdAt: "2026-08-12T11:58:00.000Z",
        startedAt: "2026-08-12T11:59:58.500Z",
      },
      {
        id: "completed",
        status: "completed",
        createdAt: "2026-08-12T10:00:00.000Z",
        startedAt: "2026-08-12T10:00:00.000Z",
        completedAt: "2026-08-12T11:01:01.000Z",
      },
      { id: "queued", status: "queued", createdAt: "invalid" },
    ];

    act(() => root.render(<SessionsTable items={items} />));
    const runningCreated = container.querySelector('[data-pw="session-created-running"] time')!;
    const runningDuration = container.querySelector('[data-pw="session-duration-running"] time')!;
    const completedDuration = container.querySelector(
      '[data-pw="session-duration-completed"] time',
    )!;

    expect(runningCreated.lastElementChild?.textContent).toBe("2 minutes ago");
    expect(runningCreated.getAttribute("title")).toBe("2026-08-12T11:58:00.000Z");
    expect(runningCreated.querySelector(".sr-only")?.textContent).toBe(
      "Created 2026-08-12T11:58:00.000Z. ",
    );
    expect(runningDuration.lastElementChild?.textContent).toBe("1s");
    expect(runningDuration.querySelector(".sr-only")?.textContent).toBe("Elapsed duration: ");
    expect(completedDuration.lastElementChild?.textContent).toBe("1h 1m 1s");
    expect(completedDuration.querySelector(".sr-only")?.textContent).toBe("Total duration: ");
    expect(container.querySelector('[data-pw="session-created-queued"]')?.textContent).toBe("—");
    expect(container.querySelector('[data-pw="session-duration-queued"]')?.textContent).toBe("—");
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(1_000));
    expect(runningDuration.lastElementChild?.textContent).toBe("2s");

    act(() => root.render(<SessionsTable items={[items[1]!]} />));
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(60_000));
    expect(
      container.querySelector('[data-pw="session-duration-completed"] time')?.lastElementChild
        ?.textContent,
    ).toBe("1h 1m 1s");
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("RelativeTime ticks its own 60-second clock and falls back to an em dash", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => root.render(<RelativeTime value="2026-08-12T11:00:00.000Z" label="Connected" />));
    const time = container.querySelector("time")!;
    expect(time.lastElementChild?.textContent).toBe("1 hour ago");
    expect(time.querySelector(".sr-only")?.textContent).toBe(
      "Connected 2026-08-12T11:00:00.000Z. ",
    );
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(60_000));
    expect(container.querySelector("time")?.lastElementChild?.textContent).toBe("1 hour ago");

    act(() => root.render(<RelativeTime value="2026-08-12T11:00:00.000Z" />));
    expect(container.querySelector("time")?.querySelector(".sr-only")).toBeNull();

    act(() => root.render(<RelativeTime value={null} />));
    expect(container.textContent).toBe("—");

    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
