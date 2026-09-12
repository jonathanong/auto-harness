// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  field,
  json,
  mountForm,
  press,
  router,
  setValue,
  submit,
} from "../../test-helpers/form-test-helpers.tsx";
import { WorkspacePoolForm } from "./workspace-pool-form.tsx";

describe("WorkspacePoolForm", () => {
  it("saves trusted setup profiles and a cleanup default on the admin configuration endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ id: "browser-tests" }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<WorkspacePoolForm />);
    setValue(field(view.container, "workspace-pool-name"), "browser-tests");
    press(field(view.container, "workspace-pool-profile-add"));
    setValue(field(view.container, "workspace-pool-profile-id-0"), "install");
    setValue(field(view.container, "workspace-pool-profile-name-0"), "Install dependencies");
    setValue(
      field(view.container, "workspace-pool-profile-script-0"),
      "pnpm install --frozen-lockfile",
    );
    setValue(field(view.container, "workspace-pool-default-profile"), "install");
    press(field(view.container, "workspace-pool-destroy-after"));
    submit(field(view.container, "form-workspace-pool-create"));
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/workspace-pools"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      name: "browser-tests",
      setupProfiles: [
        { id: "install", name: "Install dependencies", script: "pnpm install --frozen-lockfile" },
      ],
      defaultSetupProfileId: "install",
      destroyWorkspaceAfter: true,
    });
    expect(router.push).toHaveBeenCalledWith(
      "/workspace-pools/browser-tests?toast=Workspace+pool+saved.",
    );
    view.unmount();
  });

  it("updates an existing pool and clears a removed default profile", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ id: "pool-1" }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <WorkspacePoolForm
        pool={{
          id: "pool-1",
          name: "browser-tests",
          setupProfiles: [{ id: "install", name: "Install", script: "pnpm install" }],
          defaultSetupProfileId: "install",
          destroyWorkspaceAfter: true,
        }}
      />,
    );
    press(field(view.container, "workspace-pool-profile-remove-0"));
    press(field(view.container, "workspace-pool-destroy-after"));
    submit(field(view.container, "form-workspace-pool-edit"));
    await act(async () => Promise.resolve());

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/workspace-pools/pool-1"),
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      name: "browser-tests",
      setupProfiles: [],
      defaultSetupProfileId: null,
      destroyWorkspaceAfter: false,
    });
    expect(router.push).toHaveBeenCalledWith("/workspace-pools/pool-1?toast=Workspace+pool+saved.");
    view.unmount();
  });
});
