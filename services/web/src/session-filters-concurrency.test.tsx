// @vitest-environment happy-dom

import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionFilters, TooltipProvider } from "@auto-harness/ui";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
});

function mount() {
  const router = { push: vi.fn() };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        AppRouterContext.Provider,
        { value: router as never },
        createElement(
          SearchParamsContext.Provider,
          { value: new URLSearchParams() as never },
          createElement(
            TooltipProvider,
            null,
            createElement(SessionFilters, { basePath: "/runs" }),
          ),
        ),
      ),
    );
  });
  return { container, router, unmount: () => act(() => root.unmount()) };
}

describe("SessionFilters concurrency blur", () => {
  it("commits a dirty concurrency draft on blur", () => {
    const view = mount();
    const concurrency = view.container.querySelector(
      '[data-pw="session-filter-concurrency-id"]',
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(concurrency, "pr-42");
    act(() => concurrency.dispatchEvent(new Event("input", { bubbles: true })));
    act(() => {
      concurrency.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(view.router.push).toHaveBeenCalledWith("/runs?concurrencyId=pr-42");
    view.unmount();
  });
});
