// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, press, router, setValue, submit } from "./form-test-helpers.tsx";
import { ProviderAccountConcurrencyForm } from "./provider-account-concurrency-form.tsx";

describe("ProviderAccountConcurrencyForm", () => {
  it("shows the current cap, opens the editor, and cancels it", () => {
    const view = mountForm(<ProviderAccountConcurrencyForm account={{ id: "account/one" }} />);
    expect(field(view.container, "provider-account-concurrency-account/one").textContent).toContain(
      "Max concurrent sessions: 1",
    );
    press(field(view.container, "provider-account-concurrency-edit-account/one"));
    expect(
      field<HTMLInputElement>(view.container, "provider-account-concurrency-input-account/one")
        .value,
    ).toBe("1");
    press(
      [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel",
      )!,
    );
    expect(
      view.container.querySelector('[data-pw="provider-account-concurrency-form-account/one"]'),
    ).toBeNull();
    view.unmount();
  });

  it("saves an edited cap and surfaces API errors", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <ProviderAccountConcurrencyForm account={{ id: "account/one", maxConcurrentSessions: 2 }} />,
    );
    press(field(view.container, "provider-account-concurrency-edit-account/one"));
    setValue(field(view.container, "provider-account-concurrency-input-account/one"), "4");
    submit(field(view.container, "provider-account-concurrency-form-account/one"));
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledWith("/api/v1/provider-accounts/account%2Fone", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxConcurrentSessions: 4 }),
    });
    expect(router.refresh).toHaveBeenCalledOnce();
    press(field(view.container, "provider-account-concurrency-edit-account/one"));
    submit(field(view.container, "provider-account-concurrency-form-account/one"));
    await act(async () => Promise.resolve());
    view.unmount();
  });
});
