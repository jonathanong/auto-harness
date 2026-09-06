// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionQueueDeadline } from "./session-queue-deadline.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

function render(props: Parameters<typeof SessionQueueDeadline>[0]) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<SessionQueueDeadline {...props} />));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("SessionQueueDeadline", () => {
  it.each([
    [183_600_000, "2d 3h remaining"],
    [11_040_000, "3h 4m remaining"],
    [245_000, "4m 5s remaining"],
    [5_000, "5s remaining"],
    [-1, "Deadline reached"],
  ])("formats a queued deadline %s milliseconds away", (remaining, expected) => {
    const now = Date.parse("2026-08-14T12:00:00.000Z");
    const expires = new Date(now + remaining).toISOString();
    const container = render({ status: "queued", queueExpiresAt: expires, initialNow: now });

    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(expires);
    expect(container.querySelector("time")?.getAttribute("aria-label")).toBe(
      `Queue deadline ${expires}`,
    );
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.textContent).toContain(expected);
  });

  it.each([
    ["running", "2026-08-14T12:01:00.000Z"],
    ["queued", null],
    ["queued", "not-a-date"],
    ["queued", "2026-08-14"],
    ["queued", "2026-02-30T12:00:00.000Z"],
  ])("stays hidden for status %s and deadline %s", (status, queueExpiresAt) => {
    expect(render({ status, queueExpiresAt }).textContent).toBe("");
  });

  it("hydrates its clock, ticks, and stops when the deadline is reached", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-14T12:00:00.000Z");
    const container = render({
      status: "queued",
      queueExpiresAt: "2026-08-14T12:00:02.000Z",
    });

    expect(container.textContent).toContain("2s remaining");
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(2_000));
    expect(container.textContent).toContain("Deadline reached");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders a compact labeled strip and can omit its test id", () => {
    const now = Date.parse("2026-08-14T12:00:00.000Z");
    const container = render({
      status: "queued",
      queueExpiresAt: "2026-08-14T12:00:05.000Z",
      initialNow: now,
      compact: true,
      pw: null,
    });
    expect(container.querySelector("[data-pw]")).toBeNull();
    expect(container.textContent).toContain("Queue");
    expect(container.textContent).toContain("5s remaining");
  });
});
