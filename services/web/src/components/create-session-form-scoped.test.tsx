// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm } from "../../test-helpers/form-test-helpers.tsx";
import { CreateSessionForm } from "./create-session-form.tsx";

describe("CreateSessionForm without workspace mode", () => {
  it("hides workspace execution controls for repository-scoped callers", () => {
    const view = mountForm(
      <CreateSessionForm
        targets={[{ kind: "provider", id: "p/1", label: "Claude" }]}
        repositories={[{ id: "repo-1", name: "repo-one" }]}
        workspacePools={[{ id: "pool", name: "pool", setupProfiles: [] }]}
        allowWorkspace={false}
      />,
    );
    expect(view.container.querySelector('[data-pw="create-session-mode"]')).toBeNull();
    expect(view.container.querySelector('[data-pw="create-session-mode-workspace"]')).toBeNull();
    expect(field(view.container, "create-session-repository-id")).toBeInstanceOf(HTMLSelectElement);
    view.unmount();
  });
});
