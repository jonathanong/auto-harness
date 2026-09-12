// @vitest-environment happy-dom

import React from "react";
import { expect, it } from "vitest";

import { field, mountForm, setValue } from "../../test-helpers/form-test-helpers.tsx";
import { CreateSessionForm } from "./create-session-form.tsx";

it("initializes Clone and Edit in workspace mode with the source pool policy", () => {
  const view = mountForm(
    <CreateSessionForm
      targets={[{ kind: "command", id: "command", label: "Command" }]}
      repositories={[]}
      workspacePools={[
        {
          id: "pool",
          name: "Pool",
          setupProfiles: [{ id: "setup", name: "Setup" }],
          destroyWorkspaceAfter: false,
        },
        {
          id: "other-pool",
          name: "Other pool",
          setupProfiles: [{ id: "setup", name: "Different setup" }],
          destroyWorkspaceAfter: false,
        },
      ]}
      initialValues={{
        repositoryId: null,
        workspacePoolId: "pool",
        setupProfileId: "setup",
        destroyWorkspaceAfter: true,
        prompt: "clone workspace",
        target: { commandId: "command" },
        fallbacks: [],
        queueTtlSeconds: 60,
        timeout: 30,
        priority: 0,
        requiredLabels: [],
      }}
    />,
  );
  expect(view.container.querySelector('[data-pw="create-session-repository-id"]')).toBeNull();
  expect(field<HTMLSelectElement>(view.container, "create-session-workspace-pool").value).toBe(
    "pool",
  );
  expect(field<HTMLSelectElement>(view.container, "create-session-workspace-profile").value).toBe(
    "setup",
  );
  expect(field<HTMLSelectElement>(view.container, "create-session-workspace-cleanup").value).toBe(
    "true",
  );
  setValue(field<HTMLSelectElement>(view.container, "create-session-workspace-pool"), "other-pool");
  expect(field<HTMLSelectElement>(view.container, "create-session-workspace-profile").value).toBe(
    "",
  );
  view.unmount();
});
