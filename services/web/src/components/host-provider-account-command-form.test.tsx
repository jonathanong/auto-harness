// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, json, mountForm, setValue, submit } from "./form-test-helpers.tsx";
import { HostProviderAccountCommandForm } from "./host-provider-account-command-form.tsx";

const commands = [
  {
    id: "command-1",
    name: "fast",
    argv: ["fast"],
    appendPrompt: true,
    providerId: "p",
    createdAt: "now",
    updatedAt: "now",
  },
];
const inventory = {
  repositories: [],
  providerAccounts: [{ providerAccountId: "account" }],
};

describe("HostProviderAccountCommandForm", () => {
  it("saves the selected host-level command override", async () => {
    const navigate = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(inventory))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <HostProviderAccountCommandForm
        hostId="host"
        providerAccountId="account"
        currentCommandId={undefined}
        providerCommands={commands}
        navigate={navigate}
      />,
    );
    setValue(field(view.container, "host-provider-account-command-select-account"), "command-1");
    submit(field(view.container, "host-provider-account-command-form-account"));
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      providerAccounts: [{ providerAccountId: "account", commandId: "command-1" }],
    });
    expect(
      field<HTMLButtonElement>(view.container, "host-provider-account-command-submit-account")
        .disabled,
    ).toBe(false);
    expect(navigate).toHaveBeenCalledWith("/");
    view.unmount();
  });

  it("clears an inherited selection and reports a pending save failure", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          ...inventory,
          providerAccounts: [{ providerAccountId: "account", commandId: "old" }],
        }),
      )
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (finish = resolve)));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <HostProviderAccountCommandForm
        hostId="host"
        providerAccountId="account"
        currentCommandId="old"
        providerCommands={commands}
      />,
    );
    const form = field<HTMLFormElement>(
      view.container,
      "host-provider-account-command-form-account",
    );
    field(view.container, "host-provider-account-command-select-account").remove();
    submit(form);
    await act(async () => Promise.resolve());
    expect(
      field<HTMLButtonElement>(view.container, "host-provider-account-command-submit-account")
        .disabled,
    ).toBe(true);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      providerAccounts: [{ providerAccountId: "account" }],
    });
    await act(async () => finish(new Response("nope", { status: 500 })));
    expect(field(view.container, "host-provider-account-command-error-account").textContent).toBe(
      "nope",
    );
    expect(
      field<HTMLButtonElement>(view.container, "host-provider-account-command-submit-account")
        .disabled,
    ).toBe(false);
    view.unmount();
  });

  it("recovers when reading the inventory rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("inventory unavailable")));
    const view = mountForm(
      <HostProviderAccountCommandForm
        hostId="host"
        providerAccountId="account"
        currentCommandId={undefined}
        providerCommands={commands}
      />,
    );
    submit(field(view.container, "host-provider-account-command-form-account"));
    await act(async () => Promise.resolve());
    expect(field(view.container, "host-provider-account-command-error-account").textContent).toBe(
      "inventory unavailable",
    );
    expect(
      field<HTMLButtonElement>(view.container, "host-provider-account-command-submit-account")
        .disabled,
    ).toBe(false);
    view.unmount();
  });
});
