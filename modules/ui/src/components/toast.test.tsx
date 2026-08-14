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

import { RetryToast, Toast, withToast } from "./toast.tsx";

const router = {
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
} satisfies AppRouterInstance;
const navigation = {
  pathname: "/sessions",
  searchParams: new URLSearchParams(),
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
  router.replace.mockReset();
  history.replaceState(null, "", "/");
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
    expect(location.pathname).toBe("/sessions");
    expect(location.search).toBe("?filter=active");
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(view.container.querySelector('[role="status"]')).toBeNull();
    navigation.searchParams = new URLSearchParams("toast=Solo");
    view.rerender(withNavigation(<Toast />));
    await act(async () => Promise.resolve());
    expect(location.pathname).toBe("/sessions");
    expect(location.search).toBe("");
    expect(withToast("/sessions?filter=active", "Done")).toBe("/sessions?filter=active&toast=Done");
    expect(withToast("/sessions?toast=Old&filter=active", "Done")).toBe(
      "/sessions?toast=Done&filter=active",
    );
    view.unmount();
  });

  it("announces mutation failures and exposes retry progress", () => {
    const onRetry = vi.fn();
    const view = mount(<RetryToast onRetry={onRetry}>Could not delete command.</RetryToast>);
    const alert = view.container.querySelector('[data-pw="mutation-error-toast"]');
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.getAttribute("aria-atomic")).toBe("true");
    const retry = view.container.querySelector<HTMLButtonElement>(
      '[data-pw="mutation-error-retry"]',
    );
    act(() => retry?.click());
    expect(onRetry).toHaveBeenCalledOnce();

    view.rerender(
      <RetryToast onRetry={onRetry} pending>
        Could not delete command.
      </RetryToast>,
    );
    const pending = view.container.querySelector<HTMLButtonElement>(
      '[data-pw="mutation-error-retry"]',
    );
    expect(pending?.disabled).toBe(true);
    expect(pending?.textContent).toBe("Retrying…");
    view.unmount();
  });
});
