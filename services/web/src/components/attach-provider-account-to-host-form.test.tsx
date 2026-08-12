// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, json, mountForm, router, setValue, submit } from "./form-test-helpers.tsx";
import { AttachProviderAccountToHostForm } from "./attach-provider-account-to-host-form.tsx";

const accounts = [
  { id: "account-1", label: "Claude — one" },
  { id: "account-2", label: "Claude — two" },
];

describe("AttachProviderAccountToHostForm", () => {
  it("explains when every catalog account is already attached", () => {
    const view = mountForm(
      <AttachProviderAccountToHostForm hostId="host" availableAccounts={[]} />,
    );
    expect(view.container.textContent).toContain("already attached");
    view.unmount();
  });

  it("uses the selected account and refreshes after saving", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ repositories: [], providerAccounts: [], commandProfiles: {} }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <AttachProviderAccountToHostForm hostId="host/one" availableAccounts={accounts} />,
    );
    setValue(field(view.container, "attach-provider-account-select"), "account-2");
    submit(field(view.container, "form-attach-provider-account"));
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      providerAccounts: [{ providerAccountId: "account-2" }],
    });
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("submits an absent selection and shows a saving error while pending", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (finish = resolve)));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <AttachProviderAccountToHostForm hostId="host" availableAccounts={accounts} />,
    );
    const form = field<HTMLFormElement>(view.container, "form-attach-provider-account");
    field(view.container, "attach-provider-account-select").remove();
    submit(form);
    await act(async () => Promise.resolve());
    expect(
      field<HTMLButtonElement>(view.container, "attach-provider-account-submit").disabled,
    ).toBe(true);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      providerAccounts: [{ providerAccountId: "" }],
    });
    await act(async () => finish(new Response("save failed", { status: 500 })));
    expect(field(view.container, "attach-provider-account-error").textContent).toBe("save failed");
    view.unmount();
  });
});
