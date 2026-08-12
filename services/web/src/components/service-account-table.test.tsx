// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, press } from "./form-test-helpers.tsx";
import { formatCreatedAt, ServiceAccountTable } from "./service-account-table.tsx";

const accounts = [
  {
    id: "service:all",
    name: "all-ci",
    role: "operator" as const,
    createdAt: "2026-08-12T01:02:03.000Z",
  },
  {
    id: "service:scoped",
    name: "host-ci",
    role: "read-only" as const,
    createdAt: "invalid",
    allowedRepositoryIds: ["repo-1", "missing"],
    boundHostId: "host-a",
  },
];

async function settle() {
  await act(async () => Promise.resolve());
}

describe("ServiceAccountTable", () => {
  it("renders empty and complete account states without secrets", () => {
    const empty = mountForm(
      <ServiceAccountTable accounts={[]} repositories={[]} onRotate={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(field(empty.container, "service-accounts-empty")).toBeTruthy();
    empty.unmount();
    const view = mountForm(
      <ServiceAccountTable
        accounts={accounts}
        repositories={[{ id: "repo-1", name: "Repo one" }]}
        onRotate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(view.container.textContent).toContain("All repositories");
    expect(view.container.textContent).toContain("Repo one, missing");
    expect(view.container.textContent).toContain("Host: host-a");
    expect(view.container.textContent).toContain("2026-08-12");
    expect(view.container.textContent).toContain("Unknown");
    expect(view.container.textContent).not.toContain("hns_");
    expect(formatCreatedAt("bad")).toBe("Unknown");
  });

  it("rotates and explicitly confirms deletion", async () => {
    const onRotate = vi.fn().mockResolvedValue(undefined);
    const onDelete = vi.fn().mockResolvedValue(undefined);
    mountForm(
      <ServiceAccountTable
        accounts={[accounts[0]!]}
        repositories={[]}
        onRotate={onRotate}
        onDelete={onDelete}
      />,
    );
    press(field(document.body, "service-account-rotate-service:all"));
    expect(onRotate).toHaveBeenCalledWith(accounts[0]);
    press(field(document.body, "service-account-delete-service:all"));
    expect(onDelete).not.toHaveBeenCalled();
    press(field(document.body, "service-account-delete-service:all-confirm-submit"));
    await settle();
    expect(onDelete).toHaveBeenCalledWith("service:all");
  });

  it("keeps delete confirmation open for Error and non-Error failures", async () => {
    const onDelete = vi
      .fn()
      .mockRejectedValueOnce(new Error("cannot revoke"))
      .mockRejectedValueOnce("offline");
    mountForm(
      <ServiceAccountTable
        accounts={[accounts[0]!]}
        repositories={[]}
        onRotate={vi.fn()}
        onDelete={onDelete}
      />,
    );
    press(field(document.body, "service-account-delete-service:all"));
    press(field(document.body, "service-account-delete-service:all-confirm-submit"));
    await settle();
    expect(field(document.body, "service-account-delete-service:all-error").textContent).toBe(
      "cannot revoke",
    );
    press(field(document.body, "service-account-delete-service:all-confirm-submit"));
    await settle();
    expect(field(document.body, "service-account-delete-service:all-error").textContent).toBe(
      "Unable to delete account.",
    );
  });
});
