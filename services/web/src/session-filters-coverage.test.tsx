// @vitest-environment happy-dom

import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionFilters, TooltipProvider } from "@auto-harness/ui";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Router = { push: ReturnType<typeof vi.fn> };

function mount(params: string, router: Router) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (nextParams: string) => {
    act(() => {
      root.render(
        createElement(
          AppRouterContext.Provider,
          { value: router as never },
          createElement(
            SearchParamsContext.Provider,
            { value: new URLSearchParams(nextParams) as never },
            createElement(
              TooltipProvider,
              null,
              createElement(SessionFilters, { basePath: "/runs" }),
            ),
          ),
        ),
      );
    });
  };
  render(params);
  return { container, render, unmount: () => act(() => root.unmount()) };
}

function keyDown(element: Element, key: string) {
  act(() => element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key })));
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  act(() => input.dispatchEvent(new Event("input", { bubbles: true })));
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("SessionFilters", () => {
  it("reads URL state and pushes each filter, including clearing values", () => {
    const router = { push: vi.fn() };
    const view = mount("status=running&q=needle&concurrencyId=old", router);
    let status = view.container.querySelector(
      '[data-pw="session-filter-status"]',
    ) as HTMLSelectElement;
    const sort = view.container.querySelector(
      '[data-pw="session-filter-sort"]',
    ) as HTMLSelectElement;
    const q = view.container.querySelector('[data-pw="session-filter-q"]') as HTMLInputElement;
    const initialConcurrency = view.container.querySelector(
      '[data-pw="session-filter-concurrency-id"]',
    ) as HTMLInputElement;
    expect(status.value).toBe("running");
    expect(q.value).toBe("needle");
    expect(initialConcurrency.value).toBe("old");

    act(() => {
      sort.value = "priority_desc";
      sort.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(router.push).toHaveBeenLastCalledWith(
      "/runs?status=running&q=needle&concurrencyId=old&sort=priority_desc",
    );
    view.render("status=running&q=needle&concurrencyId=old&sort=priority_desc");
    status = view.container.querySelector('[data-pw="session-filter-status"]') as HTMLSelectElement;

    act(() => {
      status.value = "failed";
      status.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(router.push).toHaveBeenLastCalledWith(
      "/runs?status=failed&q=needle&concurrencyId=old&sort=priority_desc",
    );
    view.render("status=failed&q=needle&concurrencyId=old&sort=priority_desc");
    const currentQ = view.container.querySelector(
      '[data-pw="session-filter-q"]',
    ) as HTMLInputElement;

    setInputValue(currentQ, "next");
    keyDown(currentQ, "Escape");
    expect(router.push).toHaveBeenLastCalledWith(
      "/runs?status=failed&q=needle&concurrencyId=old&sort=priority_desc",
    );
    keyDown(currentQ, "Enter");
    expect(router.push).toHaveBeenLastCalledWith(
      "/runs?status=failed&q=next&concurrencyId=old&sort=priority_desc",
    );

    view.unmount();
    const cleared = mount("status=running&q=needle&concurrencyId=old", router);
    const clearedQ = cleared.container.querySelector(
      '[data-pw="session-filter-q"]',
    ) as HTMLInputElement;
    act(() => clearedQ.focus());
    setInputValue(clearedQ, "");
    expect(clearedQ.value).toBe("");
    act(() => {
      clearedQ.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(router.push).toHaveBeenLastCalledWith("/runs?status=running&concurrencyId=old");
    cleared.render("status=running&concurrencyId=old");

    const concurrency = cleared.container.querySelector(
      '[data-pw="session-filter-concurrency-id"]',
    ) as HTMLInputElement;
    setInputValue(concurrency, "new id");
    expect(concurrency.value).toBe("new id");
    keyDown(concurrency, "Enter");
    expect(router.push).toHaveBeenLastCalledWith("/runs?status=running&concurrencyId=new+id");
    act(() => concurrency.focus());
    act(() => concurrency.blur());
    expect(router.push).toHaveBeenLastCalledWith("/runs?status=running&concurrencyId=new+id");
    cleared.unmount();
  });

  it("uses defaults, preserves unchanged blur state, and syncs the draft on URL changes", () => {
    const router = { push: vi.fn() };
    const view = mount("", router);
    const q = view.container.querySelector('[data-pw="session-filter-q"]') as HTMLInputElement;
    const concurrency = view.container.querySelector(
      '[data-pw="session-filter-concurrency-id"]',
    ) as HTMLInputElement;
    expect((view.container.querySelector("select") as HTMLSelectElement).value).toBe("all");
    act(() => {
      const status = view.container.querySelector("select") as HTMLSelectElement;
      status.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(router.push).toHaveBeenCalledWith("/runs");
    router.push.mockClear();
    act(() => q.dispatchEvent(new FocusEvent("blur", { bubbles: true })));
    act(() => concurrency.dispatchEvent(new FocusEvent("blur", { bubbles: true })));
    expect(router.push).not.toHaveBeenCalled();

    act(() => {
      concurrency.value = "draft";
      concurrency.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(concurrency.value).toBe("draft");
    view.render("concurrencyId=from-url");
    expect(
      (
        view.container.querySelector(
          '[data-pw="session-filter-concurrency-id"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("from-url");
    view.unmount();
  });

  it("debounces query updates and cancels a superseded draft", () => {
    vi.useFakeTimers();
    const router = { push: vi.fn() };
    const view = mount("status=running", router);
    const q = view.container.querySelector('[data-pw="session-filter-q"]') as HTMLInputElement;
    setInputValue(q, "first");
    act(() => vi.advanceTimersByTime(299));
    expect(router.push).not.toHaveBeenCalled();
    setInputValue(q, "second");
    act(() => vi.advanceTimersByTime(299));
    expect(router.push).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(router.push).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenLastCalledWith("/runs?status=running&q=second");
    view.render("status=running&q=second");
    expect(q.value).toBe("second");
    view.unmount();
  });
});
