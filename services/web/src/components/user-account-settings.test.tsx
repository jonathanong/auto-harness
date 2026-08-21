// @vitest-environment happy-dom

import React, { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { field, mountForm, press, setValue, submit } from "./form-test-helpers.tsx";

const api = vi.hoisted(() => ({
  loadUserAccounts: vi.fn(),
  createUserAccount: vi.fn(),
  deleteUserAccount: vi.fn(),
}));

vi.mock("./user-account-api.ts", async (loadOriginal) => ({
  ...(await loadOriginal()),
  ...api,
}));

import { UserAccountSettings } from "./user-account-settings.tsx";

const alice = {
  id: "user:alice",
  username: "alice",
  role: "operator" as const,
  kind: "user" as const,
};

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
});

describe("UserAccountSettings", () => {
  it("renders an admin-only boundary without making a request", () => {
    const view = mountForm(<UserAccountSettings canManage={false} />);
    expect(field(view.container, "user-accounts-forbidden-error").textContent).toContain(
      "unscoped admin",
    );
    expect(api.loadUserAccounts).not.toHaveBeenCalled();
  });

  it("shows loading, ignores work after unmount, then renders ready accounts", async () => {
    let finish!: (value: unknown) => void;
    api.loadUserAccounts.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const loading = mountForm(<UserAccountSettings canManage />);
    expect(field(loading.container, "user-accounts-loading").getAttribute("aria-busy")).toBe(
      "true",
    );
    loading.unmount();
    await act(async () => finish({ kind: "ready", accounts: [] }));

    api.loadUserAccounts.mockResolvedValue({
      kind: "ready",
      accounts: [alice],
      repositories: [],
    });
    const ready = mountForm(<UserAccountSettings canManage />);
    await settle();
    expect(field(ready.container, "user-accounts-table").textContent).toContain("alice");
  });

  it("creates and deletes accounts while keeping passwords out of the rendered list", async () => {
    api.loadUserAccounts.mockResolvedValue({ kind: "ready", accounts: [], repositories: [] });
    api.createUserAccount.mockResolvedValue(alice);
    api.deleteUserAccount.mockResolvedValue(undefined);
    const view = mountForm(<UserAccountSettings canManage />);
    await settle();
    setValue(field(view.container, "user-account-username"), "alice");
    setValue(field(view.container, "user-account-password"), "initial-password");
    submit(field(view.container, "form-user-account-create"));
    await settle();
    expect(api.createUserAccount).toHaveBeenCalledWith({
      username: "alice",
      password: "initial-password",
      role: "operator",
    });
    expect(field(view.container, "user-account-row-alice").textContent).not.toContain(
      "initial-password",
    );
    press(field(document.body, "user-account-delete-alice"));
    press(field(document.body, "user-account-delete-alice-confirm-submit"));
    await settle();
    expect(api.deleteUserAccount).toHaveBeenCalledWith("alice");
    expect(view.container.querySelector('[data-pw="user-account-row-alice"]')).toBeNull();
    expect(field(view.container, "user-accounts-empty")).toBeTruthy();
  });

  it("passes loaded repositories into the create form", async () => {
    api.loadUserAccounts.mockResolvedValue({
      kind: "ready",
      accounts: [],
      repositories: [{ id: "r-1", name: "Repo one" }],
    });
    const view = mountForm(<UserAccountSettings canManage />);
    await settle();
    expect(
      view.container.querySelector('input[name="allowedRepositoryIds"][value="r-1"]'),
    ).toBeInstanceOf(HTMLInputElement);
  });

  it("renders forbidden, load failures, and an inert unauthorized transition", async () => {
    api.loadUserAccounts.mockResolvedValueOnce({ kind: "forbidden" });
    const forbidden = mountForm(<UserAccountSettings canManage />);
    await settle();
    expect(field(forbidden.container, "user-accounts-forbidden-error")).toBeTruthy();
    forbidden.unmount();

    api.loadUserAccounts.mockRejectedValueOnce(new Error("storage offline"));
    const failed = mountForm(<UserAccountSettings canManage />);
    await settle();
    expect(field(failed.container, "user-accounts-error").textContent).toContain("storage offline");
    failed.unmount();

    api.loadUserAccounts.mockRejectedValueOnce("offline");
    const unknown = mountForm(<UserAccountSettings canManage />);
    await settle();
    expect(field(unknown.container, "user-accounts-error").textContent).toContain("Unable to load");
    unknown.unmount();

    api.loadUserAccounts.mockResolvedValueOnce({ kind: "unauthorized" });
    const unauthorized = mountForm(<UserAccountSettings canManage />);
    await settle();
    expect(field(unauthorized.container, "user-accounts-loading")).toBeTruthy();
  });
});
