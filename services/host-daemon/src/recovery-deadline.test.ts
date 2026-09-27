import { expect, it, vi } from "vitest";
import { recoveryDeadline } from "./recovery-deadline.ts";

it("caps an absent credential recovery deadline and cancels its timer on disposal", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(1000);
    const deadline = recoveryDeadline(undefined);
    expect(deadline.deadlineAtMs).toBe(61_000);
    vi.advanceTimersByTime(59_999);
    expect(deadline.signal.aborted).toBe(false);
    deadline.dispose();
    vi.advanceTimersByTime(1);
    expect(deadline.signal.aborted).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("aborts expired deadlines immediately and earlier live deadlines when due", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(1000);
    const expired = recoveryDeadline(1000);
    expect(expired.signal.aborted).toBe(true);
    expired.dispose();
    const live = recoveryDeadline(2000);
    vi.advanceTimersByTime(1000);
    expect(live.signal.aborted).toBe(true);
    live.dispose();
  } finally {
    vi.useRealTimers();
  }
});
