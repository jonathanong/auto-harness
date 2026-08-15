// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, router } from "./form-test-helpers.tsx";
import { ControlShell } from "./control-shell.tsx";

function key(target: EventTarget, value: string, options: KeyboardEventInit = {}) {
  act(() =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, ...options })),
  );
}

describe("global keyboard shortcuts", () => {
  it("opens accessible help, traps focus, and restores the trigger on Escape", async () => {
    const view = mountForm(<ControlShell>Dashboard</ControlShell>);
    const trigger = field<HTMLButtonElement>(view.container, "keyboard-shortcuts-trigger");
    expect(trigger.getAttribute("aria-keyshortcuts")).toBe("?");
    act(() => trigger.click());

    const dialog = document.body.querySelector('[data-pw="keyboard-shortcuts-dialog"]');
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog?.getAttribute("aria-describedby")).toBeTruthy();
    expect(dialog?.textContent).toContain("Keyboard shortcuts");
    expect(dialog?.textContent).toContain("Go to Sessions");
    expect(field(document.body, "keyboard-shortcut-search").textContent).toContain(
      "Focus session search",
    );
    expect(field(document.body, "keyboard-shortcut-row").textContent).toContain(
      "Select next / previous session",
    );
    expect(field(document.body, "keyboard-shortcut-open").textContent).toContain(
      "Open selected session",
    );
    expect(dialog?.contains(document.activeElement)).toBe(true);

    key(document, "Escape");
    await act(async () => Promise.resolve());
    expect(document.body.querySelector('[data-pw="keyboard-shortcuts-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("supports direct and g-prefixed navigation with an announced prefix", () => {
    vi.useFakeTimers();
    const view = mountForm(<ControlShell>Dashboard</ControlShell>);
    key(document, "n");
    expect(router.push).toHaveBeenLastCalledWith("/sessions/new");

    key(document, "g");
    expect(field(view.container, "shortcut-sequence-status").textContent).toContain("choose");
    key(document, "s");
    expect(router.push).toHaveBeenLastCalledWith("/sessions");
    expect(field(view.container, "shortcut-sequence-status").textContent).toBe("");

    key(document, "g");
    key(document, "x");
    expect(router.push).toHaveBeenCalledTimes(2);
    key(document, "g");
    act(() => vi.advanceTimersByTime(1_500));
    expect(field(view.container, "shortcut-sequence-status").textContent).toBe("");
    key(document, "g");
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("clears a pending prefix when the visible help dialog opens", () => {
    vi.useFakeTimers();
    const view = mountForm(<ControlShell>Dashboard</ControlShell>);
    key(document, "g");
    expect(field(view.container, "shortcut-sequence-status").textContent).toContain("choose");
    act(() => field<HTMLButtonElement>(view.container, "keyboard-shortcuts-trigger").click());
    expect(field(view.container, "shortcut-sequence-status").textContent).toBe("");
    key(document, "Escape");
    key(document, "s");
    expect(router.push).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("opens help from the question mark and ignores commands while it is open", () => {
    const view = mountForm(<ControlShell>Dashboard</ControlShell>);
    key(document, "/", { shiftKey: true });
    expect(document.body.querySelector('[data-pw="keyboard-shortcuts-dialog"]')).not.toBeNull();
    key(document, "n");
    expect(router.push).not.toHaveBeenCalled();
    key(document, "?");
    expect(document.body.querySelector('[data-pw="keyboard-shortcuts-dialog"]')).not.toBeNull();
    view.unmount();
  });

  it("suppresses shortcuts in editable fields and for modified or repeated keys", () => {
    const view = mountForm(
      <ControlShell>
        <input data-test-editable="input" />
        <textarea data-test-editable="textarea" />
        <select data-test-editable="select" />
        <div data-test-editable="content" contentEditable />
        <div data-test-editable="role" role="textbox" />
      </ControlShell>,
    );
    for (const element of view.container.querySelectorAll("[data-test-editable]")) {
      key(element, "n");
      key(element, "?");
    }
    key(document, "n", { ctrlKey: true });
    key(document, "n", { altKey: true });
    key(document, "n", { metaKey: true });
    key(document, "n", { repeat: true });
    const prevented = new KeyboardEvent("keydown", { key: "n", bubbles: true, cancelable: true });
    prevented.preventDefault();
    act(() => document.dispatchEvent(prevented));
    expect(router.push).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-pw="keyboard-shortcuts-dialog"]')).toBeNull();
  });

  it("focuses session search with S and leaves editable fields with Escape", () => {
    const view = mountForm(
      <ControlShell>
        <input data-pw="session-filter-q" />
      </ControlShell>,
    );
    const search = field<HTMLInputElement>(view.container, "session-filter-q");
    expect(pressAndReport(document, "s")).toBe(true);
    expect(document.activeElement).toBe(search);
    key(search, "Escape");
    expect(document.activeElement).not.toBe(search);

    view.unmount();
    mountForm(<ControlShell>Dashboard</ControlShell>);
    expect(pressAndReport(document, "s")).toBe(false);
  });
});

function pressAndReport(target: EventTarget, value: string): boolean {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  act(() => target.dispatchEvent(event));
  return event.defaultPrevented;
}
