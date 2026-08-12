// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm, press, router } from "./form-test-helpers.tsx";
import { ListApiError, ListLoadingSkeleton } from "./list-page-states.tsx";

describe("list page states", () => {
  it("announces a retryable API failure and refreshes the route", () => {
    const view = mountForm(
      <ListApiError resource="sessions" message="API unavailable" selector="sessions" />,
    );

    const alert = field(view.container, "sessions-api-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("Could not load sessions.");
    expect(alert.textContent).toContain("API unavailable");
    press(field<HTMLButtonElement>(view.container, "sessions-api-retry"));
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("announces a configurable skeleton without exposing decoration", () => {
    const view = mountForm(
      <ListLoadingSkeleton label="repositories" selector="repositories" rows={2} />,
    );

    const loading = field(view.container, "repositories-loading");
    expect(loading.getAttribute("role")).toBe("status");
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(loading.textContent).toBe("Loading repositories…");
    expect(loading.querySelectorAll(".h-10")).toHaveLength(2);
    view.unmount();
  });
});
