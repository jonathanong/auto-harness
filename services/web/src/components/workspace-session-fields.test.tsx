// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, setValue } from "../../test-helpers/form-test-helpers.tsx";
import { WorkspaceSessionFields } from "./workspace-session-fields.tsx";

describe("WorkspaceSessionFields", () => {
  it("explains the retained pool policy when no selected pool is available", () => {
    const onPoolIdChange = vi.fn();
    const view = mountForm(
      <WorkspaceSessionFields
        pools={[
          { id: "pool-2", name: "Other pool", setupProfiles: [], destroyWorkspaceAfter: true },
        ]}
        poolId="missing"
        onPoolIdChange={onPoolIdChange}
      />,
    );

    expect(field(view.container, "create-session-workspace-profile").textContent).toContain(
      "Use the pool default",
    );
    expect(field(view.container, "create-session-workspace-cleanup").textContent).toContain(
      "Use pool policy (retain)",
    );
    setValue(field(view.container, "create-session-workspace-pool"), "pool-2");
    expect(onPoolIdChange).toHaveBeenCalledWith("pool-2");
    view.unmount();
  });

  it("keeps an explicit cleanup override in the administrator control", () => {
    const view = mountForm(
      <WorkspaceSessionFields
        pools={[
          {
            id: "pool-1",
            name: "Workspace",
            setupProfiles: [{ id: "install", name: "Install" }],
            destroyWorkspaceAfter: true,
          },
        ]}
        poolId="pool-1"
        onPoolIdChange={() => undefined}
        initialPoolId="pool-1"
        initialProfileId="install"
        initialDestroyWorkspaceAfter={false}
        canWriteExecConfig
      />,
    );

    expect(field<HTMLSelectElement>(view.container, "create-session-workspace-profile").value).toBe(
      "install",
    );
    expect(field<HTMLSelectElement>(view.container, "create-session-workspace-cleanup").value).toBe(
      "false",
    );
    view.unmount();
  });

  it("shows a destructive pool policy to users without override access", () => {
    const view = mountForm(
      <WorkspaceSessionFields
        pools={[
          { id: "pool-1", name: "Workspace", setupProfiles: [], destroyWorkspaceAfter: true },
        ]}
        poolId="pool-1"
        onPoolIdChange={() => undefined}
      />,
    );
    expect(field(view.container, "create-session-workspace-cleanup").textContent).toContain(
      "Use pool policy (destroy)",
    );
    view.unmount();
  });
});
