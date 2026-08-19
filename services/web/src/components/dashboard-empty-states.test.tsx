// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm } from "./form-test-helpers.tsx";
import { DashboardEmptyStates } from "./dashboard-empty-states.tsx";

describe("DashboardEmptyStates", () => {
  it("asks to connect a host when none are online", () => {
    const view = mountForm(
      <DashboardEmptyStates showSessions showHosts={false} hasOnlineHost={false} />,
    );
    expect(field(view.container, "dashboard-empty-connect-host").textContent).toBe(
      "Connect a host",
    );
    expect(view.container.querySelector('[data-pw="dashboard-empty-attach-host-repo"]')).toBeNull();
    view.unmount();
  });

  it("skips connect-a-host when a host is already online", () => {
    const view = mountForm(<DashboardEmptyStates showSessions showHosts={false} hasOnlineHost />);
    expect(view.container.querySelector('[data-pw="dashboard-empty-connect-host"]')).toBeNull();
    expect(field(view.container, "dashboard-empty-attach-host-repo").textContent).toBe(
      "Attach a repository to a host",
    );
    view.unmount();
  });
});
