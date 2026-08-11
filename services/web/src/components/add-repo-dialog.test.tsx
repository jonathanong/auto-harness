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
    expect(dialog.querySelector('[data-pw="repo-catalog-submit"]')?.textContent).toBe(
      "Create repository",
    );
    press(field<HTMLButtonElement>(document, "dialog-close"));
    expect(document.querySelector('[data-pw="add-repo-dialog"]')).toBeNull();
    view.unmount();
  });
});
