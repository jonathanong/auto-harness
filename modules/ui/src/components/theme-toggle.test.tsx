// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mount, reset } from "./action-form-test-helpers.ts";
import { THEME_INIT_SCRIPT, ThemeToggle } from "./theme-toggle.tsx";

/** happy-dom's window has no localStorage/matchMedia by default — a minimal stand-in for both. */
function installBrowserStorageStubs(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
}

beforeEach(installBrowserStorageStubs);

afterEach(() => {
  reset();
  document.documentElement.classList.remove("dark");
  window.localStorage.clear();
});

describe("ThemeToggle", () => {
  it("renders nothing until mounted, then reflects the current theme", () => {
    document.documentElement.classList.add("dark");
    const view = mount(<ThemeToggle />);
    const button = view.container.querySelector('[data-pw="theme-toggle"]');
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("Switch to light theme");
    view.unmount();
  });

  it("toggles the dark class, persists the choice, and notifies listeners", () => {
    const view = mount(<ThemeToggle />);
    const button = view.container.querySelector<HTMLButtonElement>('[data-pw="theme-toggle"]');
    expect(button?.getAttribute("aria-label")).toBe("Switch to dark theme");

    let notified = false;
    window.addEventListener("harness:theme-change", () => (notified = true), { once: true });
    act(() => button?.click());

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(window.localStorage.getItem("harness-theme")).toBe("dark");
    expect(notified).toBe(true);
    expect(
      view.container.querySelector('[data-pw="theme-toggle"]')?.getAttribute("aria-label"),
    ).toBe("Switch to light theme");

    act(() => button?.click());
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(window.localStorage.getItem("harness-theme")).toBe("light");
    view.unmount();
  });
});

describe("THEME_INIT_SCRIPT", () => {
  it("applies the stored preference before hydration, and system preference otherwise", () => {
    window.localStorage.setItem("harness-theme", "dark");
    document.documentElement.classList.remove("dark");
    // eslint-disable-next-line no-eval
    eval(THEME_INIT_SCRIPT);
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    window.localStorage.setItem("harness-theme", "light");
    document.documentElement.classList.add("dark");
    // eslint-disable-next-line no-eval
    eval(THEME_INIT_SCRIPT);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
