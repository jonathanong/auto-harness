// @vitest-environment happy-dom

import React, { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { field, mountForm, press, setValue, submit } from "./form-test-helpers.tsx";

const api = vi.hoisted(() => ({
  loadServiceAccountData: vi.fn(),
  createServiceAccount: vi.fn(),
  deleteServiceAccount: vi.fn(),
}));

vi.mock("./service-account-api.ts", async (loadOriginal) => ({
  ...(await loadOriginal()),
  ...api,
}));

import { ServiceAccountSettings } from "./service-account-settings.tsx";

const oldAccount = {
  id: "service:old",
  name: "ci",
  role: "operator" as const,
  createdAt: "2026-08-01T00:00:00.000Z",
  allowedRepositoryIds: ["repo-1"],
  boundHostId: "host-a",
};
const newSecret = {
  account: { ...oldAccount, id: "service:new", createdAt: "2026-08-12T00:00:00.000Z" },
  apiKey: "hns_replacement",
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

describe("ServiceAccountSettings", () => {
  it("renders an admin-only boundary without making an account request", () => {
    const view = mountForm(<ServiceAccountSettings canManage={false} />);
    expect(field(view.container, "service-accounts-forbidden-error").textContent).toContain(
      "unscoped admin",
    );
    expect(api.loadServiceAccountData).not.toHaveBeenCalled();
  });

  it("loads account data and ignores a response after unmount", async () => {
    let finish!: (value: unknown) => void;
    api.loadServiceAccountData.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = mountForm(<ServiceAccountSettings canManage />);
    expect(pending.container.querySelector('[aria-busy="true"]')).toBeTruthy();
    pending.unmount();
    await act(async () => finish({ kind: "ready", accounts: [], repositories: [], hostIds: [] }));

    api.loadServiceAccountData.mockResolvedValue({
      kind: "ready",
      accounts: [oldAccount],
      repositories: [{ id: "repo-1", name: "Repo one" }],
      hostIds: ["host-a"],
    });
    const ready = mountForm(<ServiceAccountSettings canManage />);
    await settle();
    expect(field(ready.container, "service-accounts-table").textContent).toContain("Repo one");
  });

  it("creates, rotates, revokes, and forgets one-time keys", async () => {
    api.loadServiceAccountData.mockResolvedValue({
      kind: "ready",
      accounts: [oldAccount],
      repositories: [{ id: "repo-1", name: "Repo one" }],
      hostIds: ["host-a"],
    });
    api.createServiceAccount
      .mockResolvedValueOnce({
        account: { ...oldAccount, id: "service:created", name: "new-ci" },
        apiKey: "hns_created",
      })
      .mockResolvedValueOnce(newSecret);
    api.deleteServiceAccount.mockResolvedValue(undefined);
    const view = mountForm(<ServiceAccountSettings canManage />);
    await settle();
    setValue(field(view.container, "service-account-name"), "new-ci");
    submit(field(view.container, "form-service-account-create"));
    await settle();
    expect(field(document.body, "service-account-api-key").textContent).toBe("hns_created");
    press(field(document.body, "service-account-key-done"));
    expect(document.body.textContent).not.toContain("hns_created");

    press(field(view.container, "service-account-rotate-service:old"));
    await settle();
    expect(api.createServiceAccount).toHaveBeenLastCalledWith({
      name: "ci",
      role: "operator",
      allowedRepositoryIds: ["repo-1"],
      boundHostId: "host-a",
    });
    press(field(document.body, "rotation-consumers-updated"));
    press(field(document.body, "rotation-revoke-old"));
    await settle();
    expect(api.deleteServiceAccount).toHaveBeenCalledWith("service:old");
    expect(view.container.querySelector('[data-pw="service-account-row-service:old"]')).toBeNull();
    expect(document.body.querySelector('[data-pw="rotation-warning"]')).toBeNull();
  });

  it("renders forbidden, load failures, and an inert unauthorized transition", async () => {
    api.loadServiceAccountData.mockResolvedValueOnce({ kind: "forbidden" });
    const forbidden = mountForm(<ServiceAccountSettings canManage />);
    await settle();
    expect(field(forbidden.container, "service-accounts-forbidden-error")).toBeTruthy();
    forbidden.unmount();

    api.loadServiceAccountData.mockRejectedValueOnce(new Error("storage offline"));
    const failed = mountForm(<ServiceAccountSettings canManage />);
    await settle();
    expect(failed.container.querySelector('[role="alert"]')?.textContent).toBe("storage offline");
    failed.unmount();

    api.loadServiceAccountData.mockRejectedValueOnce("offline");
    const unknown = mountForm(<ServiceAccountSettings canManage />);
    await settle();
    expect(unknown.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Unable to load",
    );
    unknown.unmount();

    api.loadServiceAccountData.mockResolvedValueOnce({ kind: "unauthorized" });
    const unauthorized = mountForm(<ServiceAccountSettings canManage />);
    await settle();
    expect(unauthorized.container.querySelector('[aria-busy="true"]')).toBeTruthy();
  });
});
