// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, json, mountForm, press, router } from "./form-test-helpers.tsx";
import { RemoveProviderAccountFromHostButton } from "./remove-provider-account-from-host-button.tsx";

function open(view: ReturnType<typeof mountForm>) {
  press(field(view.container, "host-provider-account-remove-account/one"));
  return field(document.body, "host-provider-account-remove-account/one-confirm");
}

describe("RemoveProviderAccountFromHostButton", () => {
  it("confirms a named detach and persists the remaining host account attachments", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          repositories: [],
          providerAccounts: [{ providerAccountId: "account/one" }, { providerAccountId: "keep" }],
          commandProfiles: {},
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <RemoveProviderAccountFromHostButton
        hostId="host/one"
        providerAccountId="account/one"
        label="Claude"
      />,
    );
    expect(open(view).textContent).toContain("Detach Claude from this host?");
    press(field(document.body, "host-provider-account-remove-account/one-confirm-submit"));
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/v1/hosts/host%2Fone/inventory", {
      cache: "no-store",
    });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      providerAccounts: [{ providerAccountId: "keep" }],
    });
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("keeps refresh suppressed after a pending inventory save error", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ repositories: [], providerAccounts: [], commandProfiles: {} }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (finish = resolve)));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <RemoveProviderAccountFromHostButton
        hostId="host"
        providerAccountId="account/one"
        label="Claude"
      />,
    );
    open(view);
    press(field(document.body, "host-provider-account-remove-account/one-confirm-submit"));
    await act(async () => Promise.resolve());
    expect(
      field<HTMLButtonElement>(
        document.body,
        "host-provider-account-remove-account/one-confirm-submit",
      ).disabled,
    ).toBe(true);
    await act(async () => finish(new Response("cannot save", { status: 500 })));
    expect(router.refresh).not.toHaveBeenCalled();
    expect(
      document.body.querySelector('[data-pw="host-provider-account-remove-account/one-confirm"]'),
    ).not.toBeNull();
    expect(field(document.body, "host-provider-account-remove-account/one-error").textContent).toBe(
      "cannot save",
    );
    view.unmount();

    fetch
      .mockResolvedValueOnce(json({ repositories: [], providerAccounts: [], commandProfiles: {} }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    const fallback = mountForm(
      <RemoveProviderAccountFromHostButton
        hostId="host"
        providerAccountId="account/one"
        label="Claude"
      />,
    );
    open(fallback);
    press(field(document.body, "host-provider-account-remove-account/one-confirm-submit"));
    await act(async () => Promise.resolve());
    expect(field(document.body, "host-provider-account-remove-account/one-error").textContent).toBe(
      "request failed while updating host inventory",
    );
    fallback.unmount();
  });
});
