// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm } from "./form-test-helpers.tsx";
import { SessionTargetSelect } from "./session-target-select.tsx";

const targets = [
  { kind: "provider" as const, id: "p1", label: "Claude", available: false },
  { kind: "command" as const, id: "c1", label: "Review", available: true },
  { kind: "command" as const, id: "c2", label: "Deploy", available: false },
];

describe("SessionTargetSelect", () => {
  it("groups provider and command targets and preserves an initial selection", () => {
    const view = mountForm(
      <SessionTargetSelect
        targets={targets}
        id="target"
        name="target"
        dataPw="target-select"
        defaultValue="command:c1"
      />,
    );
    const select = field<HTMLSelectElement>(view.container, "target-select");
    expect(select.required).toBe(true);
    expect(select.value).toBe("command:c1");
    expect(select.querySelector("optgroup[label='Providers']")?.textContent).toContain(
      "Claude (unavailable)",
    );
    expect(select.querySelector("optgroup[label='Commands']")?.textContent).toContain("Review");
    expect(select.querySelector("optgroup[label='Commands']")?.textContent).toContain(
      "Deploy (unavailable)",
    );
    view.unmount();
  });

  it("offers an optional empty fallback and a no-target placeholder", () => {
    const optional = mountForm(
      <SessionTargetSelect
        targets={targets}
        id="fallback"
        name="fallback"
        dataPw="fallback-select"
        optional
      />,
    );
    const fallback = field<HTMLSelectElement>(optional.container, "fallback-select");
    expect(fallback.required).toBe(false);
    expect(fallback.value).toBe("");
    expect(fallback.options[0]?.textContent).toBe("Choose a fallback…");
    optional.unmount();

    const empty = mountForm(
      <SessionTargetSelect targets={[]} id="none" name="target" dataPw="empty-select" />,
    );
    expect(field<HTMLSelectElement>(empty.container, "empty-select").options[0]?.textContent).toBe(
      "(none — add a provider or command)",
    );
    empty.unmount();
  });
});
