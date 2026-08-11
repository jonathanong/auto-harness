// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm, press, setValue } from "./form-test-helpers.tsx";
import { SessionRoutingFields } from "./session-routing-fields.tsx";

const targets = [
  { kind: "provider" as const, id: "p1", label: "Claude" },
  { kind: "command" as const, id: "c1", label: "Review" },
];

describe("SessionRoutingFields", () => {
  it("renders initial routing and adds, reorders, and removes fallbacks", () => {
    const view = mountForm(
      <SessionRoutingFields
        targets={targets}
        prefix="schedule"
        initialTarget={{ providerId: "p1" }}
        initialFallbacks={[{ commandId: "c1" }, { providerId: "p1" }]}
      />,
    );
    expect(field<HTMLSelectElement>(view.container, "schedule-target").value).toBe("provider:p1");
    expect(field<HTMLSelectElement>(view.container, "schedule-fallback-select-0").value).toBe(
      "command:c1",
    );
    expect(field<HTMLButtonElement>(view.container, "schedule-fallback-up-0").disabled).toBe(true);
    expect(field<HTMLButtonElement>(view.container, "schedule-fallback-down-1").disabled).toBe(
      true,
    );

    press(field(view.container, "schedule-fallback-up-1"));
    expect(field<HTMLButtonElement>(view.container, "schedule-fallback-down-0").disabled).toBe(
      false,
    );
    press(field(view.container, "schedule-fallback-down-0"));
    press(field(view.container, "schedule-fallback-remove-1"));
    expect(view.container.querySelector('[data-pw="schedule-fallback-1"]')).toBeNull();
    press(field(view.container, "schedule-fallback-add"));
    expect(field(view.container, "schedule-fallback-1")).toBeTruthy();
    setValue(field(view.container, "schedule-fallback-select-1"), "provider:p1");
    view.unmount();
  });

  it("defaults a create-session primary target and starts without fallback rows", () => {
    const view = mountForm(<SessionRoutingFields targets={targets} prefix="create-session" />);
    expect(field<HTMLSelectElement>(view.container, "create-session-target").value).toBe(
      "provider:p1",
    );
    expect(view.container.querySelector('[data-pw="create-session-fallback-0"]')).toBeNull();
    press(field(view.container, "create-session-fallback-add"));
    expect(field(view.container, "create-session-fallback-remove-0")).toBeTruthy();
    view.unmount();
  });
});
