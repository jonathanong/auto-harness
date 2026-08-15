// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, press } from "./form-test-helpers.tsx";
import { UserAccountTable } from "./user-account-table.tsx";

const account = {
  id: "user:alice",
  username: "alice",
  role: "operator" as const,
  kind: "user" as const,
};

async function settle() {
  await act(async () => Promise.resolve());
}

describe("UserAccountTable", () => {
  it("renders empty and public account states without passwords", () => {
    const empty = mountForm(<UserAccountTable accounts={[]} onDelete={vi.fn()} />);
    expect(field(empty.container, "user-accounts-empty")).toBeTruthy();
    empty.unmount();
    const view = mountForm(<UserAccountTable accounts={[account]} onDelete={vi.fn()} />);
    expect(field(view.container, "user-accounts-table").textContent).toContain("alice");
    expect(view.container.textContent).toContain("operator");
    expect(view.container.textContent).not.toContain("password");
  });

  it("requires explicit confirmation before deletion", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    mountForm(<UserAccountTable accounts={[account]} onDelete={onDelete} />);
    press(field(document.body, "user-account-delete-alice"));
    expect(onDelete).not.toHaveBeenCalled();
    press(field(document.body, "user-account-delete-alice-confirm-submit"));
    await settle();
    expect(onDelete).toHaveBeenCalledWith("alice");
  });

  it("keeps delete confirmation open for Error and non-Error failures", async () => {
    const onDelete = vi
      .fn()
      .mockRejectedValueOnce(new Error("cannot delete user"))
      .mockRejectedValueOnce("offline");
    mountForm(<UserAccountTable accounts={[account]} onDelete={onDelete} />);
    press(field(document.body, "user-account-delete-alice"));
    press(field(document.body, "user-account-delete-alice-confirm-submit"));
    await settle();
    expect(field(document.body, "user-account-delete-alice-error").textContent).toBe(
      "cannot delete user",
    );
    press(field(document.body, "user-account-delete-alice-confirm-submit"));
    await settle();
    expect(field(document.body, "user-account-delete-alice-error").textContent).toBe(
      "Unable to delete user account.",
    );
  });
});
