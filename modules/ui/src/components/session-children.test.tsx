// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionChildren } from "./session-children.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("SessionChildren", () => {
  it("renders direct children, a bounded continuation, and live status", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <SessionChildren
          initialItems={[{ id: "child-1", status: "running", prompt: "Split this task" }]}
          initialNextCursor="next-child"
          path="/api/v1/sessions/parent/children?limit=50"
          fetchPage={vi.fn()}
        />,
      ),
    );
    expect(container.querySelector('[data-pw="session-detail-children"]')).not.toBeNull();
    expect(container.textContent).toContain("Child sessions");
    expect(container.querySelector('[data-pw="session-row-child-1"]')).not.toBeNull();
    expect(container.querySelector('[data-pw="sessions-live-active"]')).not.toBeNull();
    expect(container.querySelector('[data-pw="sessions-load-more"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("shows an empty direct-child state and preserves an initial poll error", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <SessionChildren
          initialItems={[]}
          initialNextCursor={null}
          initialPollError="unavailable"
          path="/api/v1/sessions/parent/children"
          fetchPage={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain("No child sessions.");
    expect(container.querySelector('[data-pw="sessions-live-error"]')?.textContent).toContain(
      "unavailable",
    );
    act(() => root.unmount());
  });
});
