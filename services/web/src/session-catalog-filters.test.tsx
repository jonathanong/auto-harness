// @vitest-environment happy-dom

import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionFilters, TooltipProvider } from "@auto-harness/ui";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mount(params: string, catalogs = true) {
  const router = { push: vi.fn() };
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
              createElement(
                SessionFilters,
                catalogs
                  ? {
                      basePath: "/runs",
                      repositories: [{ id: "repo-1", label: "Repo One" }],
                      hosts: [{ id: "host-1", label: "Agent One" }],
                    }
                  : { basePath: "/runs" },
              ),
            ),
          ),
        ),
      );
    });
  };
  render(params);
  return { container, render, router, unmount: () => act(() => root.unmount()) };
}

afterEach(() => document.body.replaceChildren());

describe("session catalog filters", () => {
  it("pushes repository, agent, and source while preserving URL state", () => {
    const view = mount("status=running");
    const change = (pw: string, value: string) => {
      const select = view.container.querySelector(`[data-pw="${pw}"]`) as HTMLSelectElement;
      act(() => {
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };
    change("session-filter-repository", "repo-1");
    expect(view.router.push).toHaveBeenLastCalledWith("/runs?status=running&repositoryId=repo-1");
    view.render("status=running&repositoryId=repo-1");
    change("session-filter-agent", "host-1");
    expect(view.router.push).toHaveBeenLastCalledWith(
      "/runs?status=running&repositoryId=repo-1&hostId=host-1",
    );
    view.render("status=running&repositoryId=repo-1&hostId=host-1");
    change("session-filter-source", "ui");
    expect(view.router.push).toHaveBeenLastCalledWith(
      "/runs?status=running&repositoryId=repo-1&hostId=host-1&source=ui",
    );
    expect(view.container.textContent).toContain("Repo One");
    expect(view.container.textContent).toContain("Agent One");
    view.unmount();
  });

  it("omits empty catalog selects on fixed-scope surfaces", () => {
    const view = mount("source=schedule", false);
    expect(view.container.querySelector('[data-pw="session-filter-repository"]')).toBeNull();
    expect(view.container.querySelector('[data-pw="session-filter-agent"]')).toBeNull();
    expect(
      (view.container.querySelector('[data-pw="session-filter-source"]') as HTMLSelectElement)
        .value,
    ).toBe("schedule");
    view.unmount();
  });
});
