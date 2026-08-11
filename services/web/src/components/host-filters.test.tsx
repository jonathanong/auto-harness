// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm, router, setValue } from "./form-test-helpers.tsx";
import { HostFilters } from "./host-filters.tsx";

describe("HostFilters", () => {
  it("shows the current query filter and changes the list URL", () => {
    const view = mountForm(<HostFilters />, {
      searchParams: new URLSearchParams("online=offline"),
    });
    const select = field<HTMLSelectElement>(view.container, "host-filter-online");
    expect(field(view.container, "host-filters").className).not.toContain("opacity-70");
    expect(select.labels?.[0]?.textContent).toBe("Online");
    expect(select.value).toBe("offline");
    setValue(select, "online");
    expect(router.push).toHaveBeenCalledWith("/hosts?online=online");
    setValue(select, "all");
    expect(router.push).toHaveBeenLastCalledWith("/hosts");
    view.unmount();
  });

  it("defaults to all when the query has no online filter", () => {
    const view = mountForm(<HostFilters />);
    expect(field<HTMLSelectElement>(view.container, "host-filter-online").value).toBe("all");
    view.unmount();
  });
});
