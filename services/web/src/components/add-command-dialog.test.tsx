// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm, press } from "./form-test-helpers.tsx";
import { AddCommandDialog } from "./add-command-dialog.tsx";

const providers = [
  { id: "provider-1", name: "codex", defaultCommandId: null, createdAt: "now", updatedAt: "now" },
];

describe("AddCommandDialog", () => {
  it("opens the command form with its provider choices and closes", () => {
    const view = mountForm(<AddCommandDialog providers={providers} />);
    press(field<HTMLButtonElement>(view.container, "add-command-open"));
    const dialog = field(document, "add-command-dialog");
    expect(dialog.querySelector('[data-pw="command-catalog-provider"]')).not.toBeNull();
    expect(dialog.querySelector("[data-pw=command-catalog-submit]")?.textContent).toBe(
      "Create command",
    );
    expect(dialog.querySelector("[data-pw=dialog-close]")).not.toBeNull();
    press(field<HTMLButtonElement>(document, "dialog-close"));
    expect(document.querySelector('[data-pw="add-command-dialog"]')).toBeNull();
    view.unmount();
  });
});
