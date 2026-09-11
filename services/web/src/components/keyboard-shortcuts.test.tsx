// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it } from "vitest";

import { mountForm } from "./form-test-helpers.tsx";
import { KeyboardShortcuts } from "./keyboard-shortcuts.tsx";

describe("KeyboardShortcuts", () => {
  it("enters go-to prefix mode on g", () => {
    const view = mountForm(<KeyboardShortcuts />);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true }));
    });
    expect(view.container.textContent).toContain("Go to: choose a destination shortcut");
    view.unmount();
  });
});
