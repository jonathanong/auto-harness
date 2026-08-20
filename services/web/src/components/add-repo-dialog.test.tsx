// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm, press } from "./form-test-helpers.tsx";
import { AddRepoDialog } from "./add-repo-dialog.tsx";

describe("AddRepoDialog", () => {
  it("opens the repository form and closes from the dialog control", () => {
    const view = mountForm(<AddRepoDialog />);
    press(field<HTMLButtonElement>(view.container, "add-repo-open"));
    const dialog = field(document, "add-repo-dialog");
    expect(dialog.querySelector('[data-pw="form-repo-catalog"]')).not.toBeNull();
    expect(dialog.querySelector('[data-pw="repo-catalog-name"]')).not.toBeNull();
    expect(dialog.textContent).toContain("Attach a local path to a host separately, below.");
    expect(dialog.textContent).not.toMatch(/\bagent\b/i);
    expect(dialog.querySelector('[data-pw="repo-catalog-submit"]')?.textContent).toBe(
      "Create repository",
    );
    press(field<HTMLButtonElement>(document, "dialog-close"));
    expect(document.querySelector('[data-pw="add-repo-dialog"]')).toBeNull();
    view.unmount();

    const custom = mountForm(
      <AddRepoDialog
        triggerLabel="Add one"
        triggerPw="custom-repo-open"
        dialogPw="custom-repo-dialog"
      />,
    );
    expect(field(custom.container, "custom-repo-open").textContent).toBe("Add one");
    press(field<HTMLButtonElement>(custom.container, "custom-repo-open"));
    expect(field(document, "custom-repo-dialog")).not.toBeNull();
    custom.unmount();
  });
});
