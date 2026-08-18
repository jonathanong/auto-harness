// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { mount, reset, router } from "./action-form-test-helpers.ts";
import { SectionError } from "./section-error.tsx";

afterEach(reset);

describe("SectionError", () => {
  it("renders the resource, message, and a retry that refreshes the route", () => {
    const view = mount(
      <SectionError
        resource="provider accounts"
        message="GET /api/v1/providers → 500"
        selector="host-detail-providers"
      />,
    );
    const alert = view.container.querySelector('[data-pw="host-detail-providers-error"]');
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toContain("Could not load provider accounts.");
    expect(alert?.textContent).toContain("GET /api/v1/providers → 500");

    const retry = view.container.querySelector(
      '[data-pw="host-detail-providers-retry"]',
    ) as HTMLButtonElement;
    expect(router.refresh).not.toHaveBeenCalled();
    act(() => retry.click());
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });
});
