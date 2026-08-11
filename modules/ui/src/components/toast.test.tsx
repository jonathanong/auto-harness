// @vitest-environment happy-dom

import { createRoot } from "react-dom/client";
import { act } from "react";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Toast, withToast } from "./toast.tsx";

const replace = vi.fn();
const router = {
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  replace,
  prefetch: vi.fn(),
} satisfies AppRouterInstance;
const navigation = {
  pathname: "/sessions",
  searchParams: new URLSearchParams(),
  replace,
  router,
};

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    rerender: (next: React.ReactNode) => act(() => root.render(next)),
    unmount: () => act(() => root.unmount()),
  };
}

function withNavigation(node: React.ReactNode) {
  return (
    <AppRouterContext.Provider value={navigation.router}>
      <PathnameContext.Provider value={navigation.pathname}>
        <SearchParamsContext.Provider value={navigation.searchParams}>
          {node}
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

afterEach(() => {
  document.body.replaceChildren();
  navigation.searchParams = new URLSearchParams();
  navigation.replace.mockReset();
  vi.useRealTimers();
});

describe("shared Toast", () => {
  it("captures redirect toasts, strips their URL param, and auto-hides", async () => {
    vi.useFakeTimers();
    const view = mount(withNavigation(<Toast />));
    expect(view.container.querySelector('[role="status"]')).toBeNull();
    navigation.searchParams = new URLSearchParams("toast=Created%20session&filter=active");
    view.rerender(withNavigation(<Toast />));
    await act(async () => Promise.resolve());
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe("Created session");
    expect(navigation.replace).toHaveBeenCalledWith("/sessions?filter=active", { scroll: false });
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(view.container.querySelector('[role="status"]')).toBeNull();
    navigation.searchParams = new URLSearchParams("toast=Solo");
    view.rerender(withNavigation(<Toast />));
    await act(async () => Promise.resolve());
    expect(navigation.replace).toHaveBeenLastCalledWith("/sessions", { scroll: false });
    expect(withToast("/sessions?filter=active", "Done")).toBe("/sessions?filter=active&toast=Done");
    view.unmount();
  });
});
