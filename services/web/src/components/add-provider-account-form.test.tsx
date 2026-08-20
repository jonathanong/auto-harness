// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, router, setValue, submit } from "./form-test-helpers.tsx";
import { AddProviderAccountForm } from "./add-provider-account-form.tsx";

describe("AddProviderAccountForm", () => {
  it("exposes the required account fields and sends a trimmed account to the catalog", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<AddProviderAccountForm providerId="provider/one" />);
    const label = field<HTMLInputElement>(view.container, "provider-account-label");
    const cooldown = field<HTMLInputElement>(view.container, "provider-account-cooldown-seconds");
    expect(label.required).toBe(true);
    expect(cooldown.min).toBe("1");
    setValue(label, " account@example.test ");
    setValue(cooldown, "90");
    submit(field(view.container, "form-add-provider-account"));
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledWith("/api/v1/provider-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: "provider/one",
        label: "account@example.test",
        usageLimitCooldownSeconds: 90,
      }),
    });
    expect(label.value).toBe("");
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("uses absent-field fallbacks and displays API and malformed-response errors", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "account already exists" } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<AddProviderAccountForm providerId="provider" />);
    const form = field<HTMLFormElement>(view.container, "form-add-provider-account");
    field(view.container, "provider-account-label").remove();
    field(view.container, "provider-account-cooldown-seconds").remove();
    submit(form);
    await act(async () => Promise.resolve());
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ providerId: "provider", label: "", usageLimitCooldownSeconds: 18000 }),
    });
    expect(field(view.container, "provider-account-error").textContent).toBe(
      "account already exists",
    );
    submit(form);
    await act(async () => Promise.resolve());
    expect(field(view.container, "provider-account-error").textContent).toBe("unavailable");
    view.unmount();
  });
});
