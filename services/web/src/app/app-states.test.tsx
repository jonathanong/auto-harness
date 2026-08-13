// @vitest-environment happy-dom

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { mountForm } from "../components/form-test-helpers.tsx";
import ErrorPage from "./error.tsx";
import Loading from "./loading.tsx";
import NotFound from "./not-found.tsx";

describe("shared route states", () => {
  it("announces loading while hiding visual skeletons", () => {
    const html = renderToStaticMarkup(<Loading />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading page");
    expect(html).toContain('aria-hidden="true"');
  });

  it("renders a labelled empty not-found state with recovery links", () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toContain('aria-labelledby="not-found-heading"');
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/sessions"');
  });

  it("focuses an alert and retries a failed route", () => {
    const reset = vi.fn();
    const view = mountForm(<ErrorPage error={new Error("private detail")} reset={reset} />);
    const alert = view.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("could not be loaded");
    expect(alert?.textContent).not.toContain("private detail");
    expect(document.activeElement?.textContent).toContain("could not be loaded");
    const retry = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    retry?.click();
    expect(reset).toHaveBeenCalledOnce();
  });
});
