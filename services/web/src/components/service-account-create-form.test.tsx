// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, setValue, submit } from "./form-test-helpers.tsx";
import { ServiceAccountCreateForm } from "./service-account-create-form.tsx";

async function settle() {
  await act(async () => Promise.resolve());
}

describe("ServiceAccountCreateForm", () => {
  it("submits trimmed identity, role, host binding, and repository scope", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const view = mountForm(
      <ServiceAccountCreateForm
        repositories={[
          { id: "repo-1", name: "Repo one" },
          { id: "repo-2", name: "Repo two" },
        ]}
        hostIds={["host-a", "host-b"]}
        onCreate={onCreate}
      />,
    );
    const name = field<HTMLInputElement>(view.container, "service-account-name");
    setValue(name, " ci-bot ");
    setValue(field<HTMLSelectElement>(view.container, "service-account-role"), "admin");
    setValue(field<HTMLInputElement>(view.container, "service-account-bound-host"), " host-a ");
    view.container.querySelectorAll<HTMLInputElement>('[name="allowedRepositoryIds"]')[1]!.click();
    submit(field(view.container, "form-service-account-create"));
    await settle();
    expect(onCreate).toHaveBeenCalledWith({
      name: "ci-bot",
      role: "admin",
      allowedRepositoryIds: ["repo-2"],
      boundHostId: "host-a",
    });
    expect(name.value).toBe("");
    expect(field<HTMLInputElement>(view.container, "service-account-bound-host").value).toBe("");
  });

  it("omits empty optional scopes and shows thrown failures", async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(new Error("duplicate"))
      .mockRejectedValueOnce("offline");
    const view = mountForm(<ServiceAccountCreateForm repositories={[]} onCreate={onCreate} />);
    const form = field<HTMLFormElement>(view.container, "form-service-account-create");
    setValue(field(view.container, "service-account-name"), "bot");
    submit(form);
    await settle();
    expect(onCreate).toHaveBeenLastCalledWith({ name: "bot", role: "operator" });
    expect(field(view.container, "service-account-create-error").textContent).toBe("duplicate");
    submit(form);
    await settle();
    expect(field(view.container, "service-account-create-error").textContent).toBe(
      "Unable to create service account.",
    );
  });
});
