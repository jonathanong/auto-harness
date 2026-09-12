// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  field,
  json,
  mountForm,
  press,
  setValue,
  submit,
} from "../../test-helpers/form-test-helpers.tsx";
import { HostWorkspacePoolsSection } from "./host-workspace-pools-section.tsx";

const inventory = {
  allowedRoots: ["/workspaces"],
  repositories: [{ id: "repo", path: "/repos/repo", defaultBranch: "main", worktrees: [] }],
  providerAccounts: [],
  workspacePools: [
    { workspacePoolId: "pool-1", slots: [{ id: "old", name: "Old", path: "/workspaces/old" }] },
  ],
};

describe("HostWorkspacePoolsSection", () => {
  it("adds, edits, and removes slots through fresh inventory writes without dropping other config", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ ...inventory, version: 4 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ ...inventory, version: 5 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ ...inventory, version: 6 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <HostWorkspacePoolsSection
        hostId="host"
        inventory={inventory}
        pools={[{ id: "pool-1", name: "Pool" }]}
        canWriteExecConfig
      />,
    );
    setValue(field(view.container, "host-workspace-slot-id"), "new");
    setValue(field(view.container, "host-workspace-slot-name"), "New");
    setValue(field(view.container, "host-workspace-slot-path"), "/workspaces/new");
    submit(field(view.container, "host-workspace-slot-add"));
    await act(async () => Promise.resolve());
    const added = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(added).toMatchObject({
      version: 4,
      allowedRoots: ["/workspaces"],
      repositories: inventory.repositories,
      workspacePools: [
        {
          workspacePoolId: "pool-1",
          slots: [
            inventory.workspacePools[0]!.slots[0],
            { id: "new", name: "New", path: "/workspaces/new" },
          ],
        },
      ],
    });

    const edit = view.container.querySelector('form input[name="name"]') as HTMLInputElement;
    setValue(edit, "Renamed");
    submit(edit.closest("form")!);
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[3]?.[1]?.body)).workspacePools[0].slots[0]).toEqual({
      id: "old",
      name: "Renamed",
      path: "/workspaces/old",
    });

    press(
      [...edit.closest("form")!.querySelectorAll("button")].find(
        (button) => button.textContent === "Remove",
      )!,
    );
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[5]?.[1]?.body)).workspacePools[0].slots).toEqual([]);
    view.unmount();
  });

  it("shows attachments but withholds all mutation controls without exec-config access", () => {
    const view = mountForm(
      <HostWorkspacePoolsSection
        hostId="host"
        inventory={inventory}
        pools={[{ id: "pool-1", name: "Pool" }]}
        canWriteExecConfig={false}
      />,
    );
    expect(
      field<HTMLInputElement>(
        view.container,
        "host-workspace-pool-pool-1",
      ).querySelector<HTMLInputElement>('input[name="name"]')?.value,
    ).toBe("Old");
    expect(view.container.querySelector('[data-pw="host-workspace-slot-add"]')).toBeNull();
    expect(view.container.textContent).toContain("fleet:exec-config");
    view.unmount();
  });

  it("removes an entire pool attachment while preserving the inventory version", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ ...inventory, version: 9 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <HostWorkspacePoolsSection
        hostId="host"
        inventory={inventory}
        pools={[{ id: "pool-1", name: "Pool" }]}
        canWriteExecConfig
      />,
    );
    const removePool = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Remove pool",
    );
    expect(removePool).toBeTruthy();
    press(removePool!);
    await act(async () => Promise.resolve());

    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      version: 9,
      workspacePools: [],
    });
    view.unmount();
  });
});
