// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { SessionsTable } from "./sessions-table.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SessionsTable
        items={[
          { id: "lf", status: "queued", prompt: "First line\nSecond <strong>unsafe</strong>" },
          { id: "crlf", status: "queued", prompt: "Windows first\r\nWindows second" },
          { id: "cr", status: "queued", prompt: "Old first\rOld second" },
          { id: "single", status: "queued", prompt: "One line" },
          { id: "empty", status: "queued", prompt: "" },
          { id: "missing", status: "queued", prompt: null },
        ]}
      />,
    );
  });
  return { container, unmount: () => act(() => root.unmount()) };
}

function row(container: Element, id: string): HTMLElement {
  return container.querySelector(`[data-pw="session-row-${id}"]`) as HTMLElement;
}

afterEach(() => document.body.replaceChildren());

describe("SessionsTable prompt disclosure", () => {
  it("shows only the first text line and expands or collapses the full safe prompt", () => {
    const view = mount();
    const lf = row(view.container, "lf");
    const text = lf.querySelector('[data-pw="session-prompt"]') as HTMLElement;
    const toggle = lf.querySelector('[data-pw="session-prompt-toggle"]') as HTMLButtonElement;

    expect(text.textContent).toBe("First line");
    expect(text.className).toContain("truncate");
    expect(text.querySelector("strong")).toBeNull();
    expect(toggle.textContent).toBe("Show full prompt");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(text.id);
    expect(toggle.getAttribute("aria-label")).toBe("Expand prompt for session lf");

    act(() => toggle.click());
    expect(text.textContent).toBe("First line\nSecond <strong>unsafe</strong>");
    expect(text.className).toContain("whitespace-pre-wrap");
    expect(text.querySelector("strong")).toBeNull();
    expect(toggle.textContent).toBe("Show first line");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Collapse prompt for session lf");

    act(() => toggle.click());
    expect(text.textContent).toBe("First line");
    expect(row(view.container, "crlf").textContent).toContain("Windows first");
    expect(row(view.container, "crlf").textContent).not.toContain("Windows second");
    expect(row(view.container, "cr").textContent).toContain("Old first");
    expect(row(view.container, "cr").textContent).not.toContain("Old second");
    expect(
      row(view.container, "single").querySelector('[data-pw="session-prompt-toggle"]'),
    ).toBeNull();
    expect(
      row(view.container, "empty").querySelector('[data-pw="session-prompt"]')?.textContent,
    ).toBe("");
    expect(
      row(view.container, "missing").querySelector('[data-pw="session-prompt"]')?.textContent,
    ).toBe("—");
    view.unmount();
  });
});
