// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { SessionDetail } from "./session-detail.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mount(defaultTab?: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <SessionDetail
        session={{
          id: "session/a",
          status: "completed",
          prompt: "Ship it",
          resolvedArgv: ["codex", "exec", "Ship it"],
          priority: 4,
          startedAt: "2026-08-12T12:00:00.000Z",
          completedAt: "2026-08-12T12:01:00.000Z",
          exitCode: 0,
        }}
        breadcrumbs={[]}
        defaultTab={defaultTab}
      >
        <p data-pw="logs-body">logs</p>
      </SessionDetail>,
    ),
  );
  return { container, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/sessions/session%2Fa");
});

describe("SessionDetail tabs", () => {
  it("keeps logs mounted while switching to details and prompts, and persists the tab", () => {
    window.history.replaceState(null, "", "/sessions/session%2Fa");
    const view = mount();
    expect(view.container.querySelector('[data-pw="logs-body"]')).not.toBeNull();
    expect(view.container.querySelector('[data-pw="session-detail-priority"]')).toBeNull();

    act(() => {
      (view.container.querySelector('[data-pw="tab-details"]') as HTMLButtonElement).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
    });
    expect(window.location.search).toBe("?tab=details");
    expect(view.container.querySelector('[data-pw="session-detail-priority"]')?.textContent).toBe(
      "4",
    );
    expect(view.container.querySelector('[data-pw="logs-body"]')).not.toBeNull();

    act(() => {
      (view.container.querySelector('[data-pw="tab-prompts"]') as HTMLButtonElement).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
    });
    expect(window.location.search).toBe("?tab=prompts");
    expect(
      view.container.querySelector('[data-pw="session-detail-prompt-content"]')?.textContent,
    ).toBe("Ship it");
    expect(view.container.textContent).toContain("‹prompt›");

    act(() => {
      (view.container.querySelector('[data-pw="tab-logs"]') as HTMLButtonElement).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
    });
    expect(window.location.search).toBe("");
    view.unmount();
  });

  it("falls unknown defaultTab values back to logs", () => {
    const view = mount("nope");
    expect(view.container.querySelector('[data-pw="tab-logs"]')?.getAttribute("data-state")).toBe(
      "active",
    );
    expect(view.container.querySelector('[data-pw="logs-body"]')).not.toBeNull();
    view.unmount();
  });
});
