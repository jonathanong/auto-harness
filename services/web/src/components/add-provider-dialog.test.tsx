// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm, press } from "./form-test-helpers.tsx";
import { AddProviderDialog } from "./add-provider-dialog.tsx";

describe("AddProviderDialog", () => {
  it("opens the provider form and closes from the dialog control", () => {
    const view = mountForm(<AddProviderDialog />);
    press(field<HTMLButtonElement>(view.container, "add-provider-open"));
    const dialog = field(document, "add-provider-dialog");
    expect(dialog.querySelector('[data-pw="form-provider-catalog"]')).not.toBeNull();
    expect(dialog.querySelector('[data-pw="provider-catalog-name"]')).not.toBeNull();
    expect(dialog.querySelector('[data-pw="provider-catalog-submit"]')?.textContent).toBe(
      "Create provider",
    );
    press(field<HTMLButtonElement>(document, "dialog-close"));
    expect(document.querySelector('[data-pw="add-provider-dialog"]')).toBeNull();
    view.unmount();
  });
});
