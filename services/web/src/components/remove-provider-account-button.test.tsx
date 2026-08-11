// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, press, router } from "./form-test-helpers.tsx";
import { RemoveProviderAccountButton } from "./remove-provider-account-button.tsx";

function open(view: ReturnType<typeof mountForm>, accountId = "account/one") {
  press(field(view.container, `provider-account-remove-${accountId}`));
  return field(document.body, `provider-account-remove-${accountId}-confirm`);
}

describe("RemoveProviderAccountButton", () => {
  it("explains the unattached and singular attachment removal consequences", () => {
    const unattached = mountForm(
      <RemoveProviderAccountButton accountId="unattached" attachedHostCount={0} />,
    );
    expect(open(unattached, "unattached").textContent).toContain("Permanently remove");
    press(field(document.body, "dialog-close"));
    const attached = mountForm(
      <RemoveProviderAccountButton accountId="attached" attachedHostCount={1} />,
    );
    expect(open(attached, "attached").textContent).toContain("Attached to 1 host —");
    unattached.unmount();
    attached.unmount();
  });

  it("disables confirmation while deleting, then refreshes after success", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (finish = resolve)));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <RemoveProviderAccountButton accountId="account/one" attachedHostCount={2} />,
    );
    expect(open(view).textContent).toContain("Attached to 2 hosts —");
    press(field(document.body, "provider-account-remove-account/one-confirm-submit"));
    expect(
      field<HTMLButtonElement>(document.body, "provider-account-remove-account/one-confirm-submit")
        .disabled,
    ).toBe(true);
    await act(async () => finish(new Response(null, { status: 204 })));
    expect(fetch).toHaveBeenCalledWith("/api/v1/provider-accounts/account%2Fone", {
      method: "DELETE",
    });
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(
      document.body.querySelector('[data-pw="provider-account-remove-account/one-confirm"]'),
    ).toBeNull();
    view.unmount();
  });

  it("closes the confirmation without refreshing after a failed deletion", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <RemoveProviderAccountButton accountId="account" attachedHostCount={0} />,
    );
    open(view, "account");
    press(field(document.body, "provider-account-remove-account-confirm-submit"));
    await act(async () => Promise.resolve());
    expect(router.refresh).not.toHaveBeenCalled();
    expect(
      document.body.querySelector('[data-pw="provider-account-remove-account-confirm"]'),
    ).toBeNull();
    view.unmount();
  });
});
