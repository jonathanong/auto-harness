// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, setValue, submit } from "./form-test-helpers.tsx";
import { UserAccountCreateForm } from "./user-account-create-form.tsx";

async function settle() {
  await act(async () => Promise.resolve());
}

describe("UserAccountCreateForm", () => {
  it("submits a trimmed username, write-only password, and selected role", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const view = mountForm(<UserAccountCreateForm onCreate={onCreate} />);
    const username = field<HTMLInputElement>(view.container, "user-account-username");
    const password = field<HTMLInputElement>(view.container, "user-account-password");
    expect(password.type).toBe("password");
    expect(password.autocomplete).toBe("new-password");
    setValue(username, " alice ");
    setValue(password, " initial password ");
    setValue(field<HTMLSelectElement>(view.container, "user-account-role"), "admin");
    submit(field(view.container, "form-user-account-create"));
    await settle();
    expect(onCreate).toHaveBeenCalledWith({
      username: "alice",
      password: " initial password ",
      role: "admin",
    });
    expect(username.value).toBe("");
    expect(password.value).toBe("");
  });

  it("preserves form values and reports Error and non-Error failures", async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(new Error("username already exists"))
      .mockRejectedValueOnce("offline");
    const view = mountForm(<UserAccountCreateForm onCreate={onCreate} />);
    const form = field<HTMLFormElement>(view.container, "form-user-account-create");
    const username = field<HTMLInputElement>(view.container, "user-account-username");
    const password = field<HTMLInputElement>(view.container, "user-account-password");
    setValue(username, "alice");
    setValue(password, "secret");
    submit(form);
    await settle();
    expect(field(document.body, "user-account-create-error").textContent).toBe(
      "username already exists",
    );
    expect(password.value).toBe("secret");
    submit(form);
    await settle();
    expect(field(document.body, "user-account-create-error").textContent).toBe(
      "Unable to create user account.",
    );
  });

  it("submits selected repository scope when catalog options are provided", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const view = mountForm(
      <UserAccountCreateForm
        repositories={[
          { id: "r-1", name: "Repo one" },
          { id: "r-2", name: "Repo two" },
        ]}
        onCreate={onCreate}
      />,
    );
    setValue(field<HTMLInputElement>(view.container, "user-account-username"), "alice");
    setValue(field<HTMLInputElement>(view.container, "user-account-password"), "secret");
    const repo = view.container.querySelector<HTMLInputElement>(
      'input[name="allowedRepositoryIds"][value="r-1"]',
    );
    expect(repo).toBeInstanceOf(HTMLInputElement);
    repo!.checked = true;
    repo!.dispatchEvent(new Event("input", { bubbles: true }));
    submit(field(view.container, "form-user-account-create"));
    await settle();
    expect(onCreate).toHaveBeenCalledWith({
      username: "alice",
      password: "secret",
      role: "operator",
      allowedRepositoryIds: ["r-1"],
    });
  });

  it("hides repository scope when the selected role is admin", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const view = mountForm(
      <UserAccountCreateForm
        repositories={[{ id: "r-1", name: "Repo one" }]}
        onCreate={onCreate}
      />,
    );
    expect(
      view.container.querySelector('input[name="allowedRepositoryIds"][value="r-1"]'),
    ).toBeInstanceOf(HTMLInputElement);
    setValue(field<HTMLSelectElement>(view.container, "user-account-role"), "admin");
    expect(
      view.container.querySelector('input[name="allowedRepositoryIds"][value="r-1"]'),
    ).toBeNull();
    setValue(field<HTMLInputElement>(view.container, "user-account-username"), "alice");
    setValue(field<HTMLInputElement>(view.container, "user-account-password"), "secret");
    submit(field(view.container, "form-user-account-create"));
    await settle();
    expect(onCreate).toHaveBeenCalledWith({
      username: "alice",
      password: "secret",
      role: "admin",
    });
  });

  it("keeps safe defaults if malformed markup omits fields", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const view = mountForm(<UserAccountCreateForm onCreate={onCreate} />);
    const form = field<HTMLFormElement>(view.container, "form-user-account-create");
    field(view.container, "user-account-username").remove();
    field(view.container, "user-account-password").remove();
    field(view.container, "user-account-role").remove();
    submit(form);
    await settle();
    expect(onCreate).toHaveBeenCalledWith({ username: "", password: "", role: "operator" });
  });
});
