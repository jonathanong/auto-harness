// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import LoginPage from "../app/login/page.tsx";
import { ChangePasswordForm } from "./change-password-form.tsx";
import {
  createApiFake,
  field,
  json,
  mountForm,
  press,
  router,
  setValue,
  submit,
} from "./form-test-helpers.tsx";
import { LoginForm } from "./login-form.tsx";
import { LogoutButton } from "./logout-button.tsx";

async function settle() {
  await act(async () => Promise.resolve());
  await act(async () => Promise.resolve());
}

describe("auth forms", () => {
  it("renders the login page and signs in", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign, pathname: "/login", search: "" });
    createApiFake(json({ ok: true }));
    const view = mountForm(<LoginPage />);
    expect(field(view.container, "page-login")).toBeTruthy();
    setValue(field<HTMLInputElement>(view.container, "login-username"), "alice");
    setValue(field<HTMLInputElement>(view.container, "login-password"), "secret");
    submit(field(view.container, "form-login"));
    await settle();
    expect(assign).toHaveBeenCalledWith("/");
  });

  it("toasts an invalid login and still mounts LoginForm directly", async () => {
    createApiFake(json({ error: "nope" }, 401));
    const view = mountForm(<LoginForm />);
    submit(field(view.container, "form-login"));
    await settle();
    expect(field(document.body, "login-error").textContent).toContain("Invalid username");
  });

  it("changes a password and reports API errors", async () => {
    createApiFake(json({ error: { message: "wrong password" } }, 400), json({ ok: true }));
    const view = mountForm(<ChangePasswordForm />);
    const form = field<HTMLFormElement>(view.container, "form-change-password");
    setValue(field<HTMLInputElement>(view.container, "change-password-current"), "old");
    setValue(field<HTMLInputElement>(view.container, "change-password-new"), "new");
    submit(form);
    await settle();
    expect(field(document.body, "change-password-error").textContent).toContain("wrong password");
    submit(form);
    await settle();
    expect(field(view.container, "change-password-ok").textContent).toContain("Password changed");
  });

  it("logs out and replaces the location with /login", async () => {
    createApiFake(json({ ok: true }));
    const view = mountForm(<LogoutButton />);
    press(field(view.container, "logout"));
    await settle();
    expect(router.replace).toHaveBeenCalledWith("/login");
  });
});
