// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatRemainingTime,
  SessionTimeoutProgress,
  timeoutProgress,
} from "./session-timeout-progress.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-08-12T12:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("session timeout progress", () => {
  it("derives bounded progress and formats remaining time", () => {
    expect(
      timeoutProgress({ status: "queued", ackReceivedAt: "now", timeout: 30 }, NOW),
    ).toBeNull();
    expect(timeoutProgress({ status: "running", timeout: 30 }, NOW)).toBeNull();
    expect(
      timeoutProgress({ status: "running", ackReceivedAt: "2026-08-12T12:00:00.000Z" }, NOW),
    ).toBeNull();
    expect(
      timeoutProgress(
        { status: "running", ackReceivedAt: "2026-08-12T12:00:00.000Z", timeout: 0 },
        NOW,
      ),
    ).toBeNull();
    expect(
      timeoutProgress({ status: "running", ackReceivedAt: "invalid", timeout: 30 }, NOW),
    ).toBeNull();
    expect(
      timeoutProgress(
        {
          status: "running",
          ackReceivedAt: "2026-08-12T12:00:00.000Z",
          timeout: Number.NaN,
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      timeoutProgress(
        { status: "running", ackReceivedAt: "2026-08-12T11:59:30.000Z", timeout: 120 },
        NOW,
      ),
    ).toEqual({
      elapsedSeconds: 30,
      remainingSeconds: 90,
      timeoutSeconds: 120,
      elapsedPercent: 25,
    });
    expect(
      timeoutProgress(
        { status: "running", ackReceivedAt: "2026-08-12T12:00:30.000Z", timeout: 120 },
        NOW,
      ),
    ).toMatchObject({ elapsedSeconds: 0, remainingSeconds: 120 });
    expect(
      timeoutProgress(
        { status: "running", ackReceivedAt: "2026-08-12T11:00:00.000Z", timeout: 120 },
        NOW,
      ),
    ).toMatchObject({ elapsedSeconds: 120, remainingSeconds: 0, elapsedPercent: 100 });
    expect(formatRemainingTime(8.1)).toBe("9s");
    expect(formatRemainingTime(68.1)).toBe("1m 9s");
    expect(formatRemainingTime(3_668.1)).toBe("1h 1m 9s");
  });

  it("ticks an accessible running progress bar and removes its timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() =>
      root.render(
        <SessionTimeoutProgress
          status="running"
          ackReceivedAt="2026-08-12T11:59:30.000Z"
          timeout={120}
        />,
      ),
    );
    const progress = container.querySelector('[role="progressbar"]')!;
    expect(progress.getAttribute("aria-valuenow")).toBe("30");
    expect(progress.getAttribute("aria-valuemax")).toBe("120");
    expect(progress.getAttribute("aria-valuetext")).toBe("1m 30s remaining");
    expect(container.querySelector('[data-pw="session-timeout-remaining"]')?.textContent).toBe(
      "1m 30s remaining",
    );
    expect(progress.firstElementChild?.getAttribute("style")).toContain("width: 25%");
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(1_000));
    expect(progress.getAttribute("aria-valuenow")).toBe("31");
    expect(progress.getAttribute("aria-valuetext")).toBe("1m 29s remaining");

    act(() => vi.advanceTimersByTime(89_000));
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    act(() => root.render(<SessionTimeoutProgress status="completed" timeout={120} />));
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    act(() => root.unmount());
  });

  it("renders no progress for invalid or already-expired acknowledgement deadlines", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() =>
      root.render(<SessionTimeoutProgress status="running" ackReceivedAt="invalid" timeout={30} />),
    );
    expect(container.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    act(() =>
      root.render(
        <SessionTimeoutProgress
          status="running"
          ackReceivedAt="2026-08-12T11:59:00.000Z"
          timeout={30}
        />,
      ),
    );
    expect(container.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
