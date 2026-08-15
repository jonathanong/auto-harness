// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionsTable } from "./sessions-table.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const items = [
  { id: "first", status: "queued" },
  { id: "second/encoded", status: "running" },
] as const;

function press(target: EventTarget, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  act(() => target.dispatchEvent(event));
  return event;
}

function mount(hrefBase: string | undefined = "/sessions") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<SessionsTable items={[...items]} hrefBase={hrefBase} />));
  return { container, root };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("sessions table keyboard navigation", () => {
  it("selects, focuses, clamps, and opens visible session rows", async () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const { container, root } = mount();
    const first = container.querySelector<HTMLElement>('[data-session-row-id="first"]')!;
    const second = container.querySelector<HTMLElement>('[data-session-row-id="second/encoded"]')!;
    const link = container.querySelector<HTMLAnchorElement>(
      '[data-session-link-id="second/encoded"]',
    )!;
    const click = vi.spyOn(link, "click").mockImplementation(() => undefined);

    expect(container.querySelector("table")?.getAttribute("aria-keyshortcuts")).toBe("J K Enter");
    expect(press(document, "j").defaultPrevented).toBe(true);
    await act(async () => Promise.resolve());
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(first);
    press(document, "J");
    await act(async () => Promise.resolve());
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(second);
    press(document, "j");
    await act(async () => Promise.resolve());
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(press(document, "Enter").defaultPrevented).toBe(true);
    expect(click).toHaveBeenCalledOnce();

    press(document, "k");
    await act(async () => Promise.resolve());
    expect(first.getAttribute("aria-selected")).toBe("true");
    press(document, "k");
    await act(async () => Promise.resolve());
    expect(first.getAttribute("aria-selected")).toBe("true");
    act(() => root.unmount());
  });

  it("starts K at the last row, supports pointer selection, and ignores unsafe keys", async () => {
    const { container, root } = mount();
    const first = container.querySelector<HTMLElement>('[data-session-row-id="first"]')!;
    const second = container.querySelector<HTMLElement>('[data-session-row-id="second/encoded"]')!;
    const input = document.createElement("input");
    container.append(input);

    press(input, "j");
    press(document, "j", { ctrlKey: true });
    press(document, "j", { altKey: true });
    press(document, "j", { metaKey: true });
    press(document, "j", { repeat: true });
    const prevented = new KeyboardEvent("keydown", {
      key: "j",
      bubbles: true,
      cancelable: true,
    });
    prevented.preventDefault();
    act(() => document.dispatchEvent(prevented));
    press(document, "x");
    expect(first.getAttribute("aria-selected")).toBe("false");

    press(document, "k");
    await act(async () => Promise.resolve());
    expect(second.getAttribute("aria-selected")).toBe("true");
    act(() => first.click());
    expect(first.getAttribute("aria-selected")).toBe("true");
    act(() => root.unmount());
  });

  it("is inert for empty tables and does not open rows without links", async () => {
    const emptyContainer = document.createElement("div");
    document.body.append(emptyContainer);
    const emptyRoot = createRoot(emptyContainer);
    act(() => emptyRoot.render(<SessionsTable items={[]} hrefBase="/sessions" />));
    expect(press(document, "j").defaultPrevented).toBe(false);
    act(() => emptyRoot.unmount());

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<SessionsTable items={[...items]} />));
    press(document, "j");
    await act(async () => Promise.resolve());
    expect(
      container.querySelector('[data-session-row-id="first"]')?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(press(document, "Enter").defaultPrevented).toBe(false);
    act(() => root.unmount());
  });
});
