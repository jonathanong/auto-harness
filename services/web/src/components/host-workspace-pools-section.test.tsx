/* eslint-disable max-lines -- workspace attachment mutation edge coverage shares its fixture. */
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

  it("adds a new pool attachment and disables additions when no pools are configured", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ ...inventory, version: 10 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <HostWorkspacePoolsSection
        hostId="host"
        inventory={inventory}
        pools={[{ id: "pool-2", name: "Second pool" }]}
        canWriteExecConfig
      />,
    );
    setValue(field(view.container, "host-workspace-slot-id"), "second");
    setValue(field(view.container, "host-workspace-slot-name"), "Second");
    setValue(field(view.container, "host-workspace-slot-path"), "/workspaces/second");
    submit(field(view.container, "host-workspace-slot-add"));
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).workspacePools).toContainEqual({
      workspacePoolId: "pool-2",
      slots: [{ id: "second", name: "Second", path: "/workspaces/second" }],
    });
    view.unmount();

    const empty = mountForm(
      <HostWorkspacePoolsSection
        hostId="host"
        inventory={inventory}
        pools={[]}
        canWriteExecConfig
      />,
    );
    expect(
      field<HTMLButtonElement>(empty.container, "host-workspace-slot-add-submit").disabled,
    ).toBe(true);
    empty.unmount();
  });

  it("uses the attachment id when the workspace catalog no longer has that pool", () => {
    const view = mountForm(
      <HostWorkspacePoolsSection
        hostId="host"
        inventory={inventory}
        pools={[]}
        canWriteExecConfig={false}
      />,
    );

    expect(field(view.container, "host-workspace-pool-pool-1").textContent).toContain("pool-1");
    view.unmount();
  });

  it("reports a rejected inventory mutation without navigating away", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ ...inventory, version: 11 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "workspace slot is busy" } }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <HostWorkspacePoolsSection
        hostId="host"
        inventory={inventory}
        pools={[{ id: "pool-1", name: "Pool" }]}
        canWriteExecConfig
      />,
    );

    press(
      [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Remove pool",
      )!,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(field(view.container, "host-workspace-pools-error").textContent).toBe(
      "workspace slot is busy",
    );
    view.unmount();
  });

  it("reports a failed inventory request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));
    const view = mountForm(
      <HostWorkspacePoolsSection
        hostId="host"
        inventory={inventory}
        pools={[{ id: "pool-1", name: "Pool" }]}
        canWriteExecConfig
      />,
    );

    press(
      [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Remove pool",
      )!,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(field(view.container, "host-workspace-pools-error").textContent).toBe(
      "network unavailable",
    );
    view.unmount();
  });

  it("handles absent inventories and preserves nonmatching pools and slots", async () => {
    const withoutAttachments = { ...inventory, workspacePools: undefined };
    const empty = mountForm(
      <HostWorkspacePoolsSection
        hostId="host"
        inventory={withoutAttachments}
        pools={[{ id: "pool-1", name: "Pool" }]}
        canWriteExecConfig={false}
      />,
    );
    expect(empty.container.querySelectorAll("section")).toHaveLength(0);
    empty.unmount();

    const expanded = {
      ...inventory,
      workspacePools: [
        {
          workspacePoolId: "pool-1",
          slots: [
            inventory.workspacePools[0]!.slots[0],
            { id: "other", name: "Other", path: "/workspaces/other" },
          ],
        },
        {
          workspacePoolId: "pool-2",
          slots: [{ id: "second", name: "Second", path: "/workspaces/second" }],
        },
      ],
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ ...expanded, version: 20 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ ...expanded, version: 21 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ ...expanded, version: 22 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <HostWorkspacePoolsSection
        hostId="host"
        inventory={inventory}
        pools={[
          { id: "pool-1", name: "Pool" },
          { id: "pool-2", name: "Other pool" },
        ]}
        canWriteExecConfig
      />,
    );

    const editForm = view.container.querySelector('form input[name="name"]')!.closest("form")!;
    for (const input of editForm.querySelectorAll("input")) input.removeAttribute("name");
    submit(editForm);
    await act(async () => Promise.resolve());
    const edited = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).workspacePools;
    expect(edited[0].slots).toEqual([
      { id: "", name: "", path: "" },
      expanded.workspacePools[0]!.slots[1],
    ]);
    expect(edited[1]).toEqual(expanded.workspacePools[1]);

    press(
      [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Remove",
      )!,
    );
    await act(async () => Promise.resolve());
    const removed = JSON.parse(String(fetch.mock.calls[3]?.[1]?.body)).workspacePools;
    expect(removed[0].slots).toEqual([expanded.workspacePools[0]!.slots[1]]);
    expect(removed[1]).toEqual(expanded.workspacePools[1]);

    const addForm = field<HTMLFormElement>(view.container, "host-workspace-slot-add");
    setValue(addForm.querySelector('select[name="poolId"]')!, "pool-1");
    for (const input of addForm.querySelectorAll("input")) input.removeAttribute("name");
    submit(addForm);
    await act(async () => Promise.resolve());
    const added = JSON.parse(String(fetch.mock.calls[5]?.[1]?.body)).workspacePools;
    expect(added[0].slots.at(-1)).toEqual({ id: "", name: "", path: "" });
    expect(added[1]).toEqual(expanded.workspacePools[1]);
    view.unmount();
  });

  it("creates missing attachment arrays from fresh inventory reads", async () => {
    const current = { ...inventory, workspacePools: undefined, version: 30 };
    const fetch = vi.fn();
    for (let index = 0; index < 4; index += 1) {
      fetch
        .mockResolvedValueOnce(json({ ...current, version: current.version + index }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
    }
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <HostWorkspacePoolsSection
        hostId="host"
        inventory={inventory}
        pools={[{ id: "pool-1", name: "Pool" }]}
        canWriteExecConfig
      />,
    );

    press(
      [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Remove pool",
      )!,
    );
    await act(async () => Promise.resolve());

    const slotForm = view.container.querySelector('form input[name="name"]')!.closest("form")!;
    submit(slotForm);
    await act(async () => Promise.resolve());
    press(
      [...slotForm.querySelectorAll("button")].find((button) => button.textContent === "Remove")!,
    );
    await act(async () => Promise.resolve());

    const addForm = field<HTMLFormElement>(view.container, "host-workspace-slot-add");
    addForm.querySelector("select")!.removeAttribute("name");
    submit(addForm);
    await act(async () => Promise.resolve());

    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).workspacePools).toEqual([]);
    expect(JSON.parse(String(fetch.mock.calls[3]?.[1]?.body)).workspacePools).toEqual([]);
    expect(JSON.parse(String(fetch.mock.calls[5]?.[1]?.body)).workspacePools).toEqual([]);
    expect(JSON.parse(String(fetch.mock.calls[7]?.[1]?.body)).workspacePools).toEqual([
      {
        workspacePoolId: "",
        slots: [{ id: "", name: "", path: "" }],
      },
    ]);
    view.unmount();
  });
});
