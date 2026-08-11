// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, json, mountForm, router, setValue, submit } from "./form-test-helpers.tsx";
import { ScopeProviderEnabledForm } from "./scope-provider-enabled-form.tsx";

const inventory = {
  repositories: [{ id: "repo/one", path: "/repo", defaultBranch: "main", worktrees: [] }],
  providerAccounts: [{ providerAccountId: "account/one" }],
  commandProfiles: {},
};

describe("ScopeProviderEnabledForm", () => {
  it("shows inherit, enabled, and disabled states and saves each selection", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(inventory))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json(inventory))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json(inventory))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <ScopeProviderEnabledForm
        hostId="host/one"
        scope={{ repositoryId: "repo/one" }}
        providerAccountId="account/one"
        currentOverride={undefined}
        inheritedLabel="host"
      />,
    );
    const select = field<HTMLSelectElement>(
      view.container,
      "scope-provider-enabled-select-account/one",
    );
    expect([...select.options].map((option) => option.text)).toEqual([
      "(inherit from host)",
      "Enabled",
      "Disabled",
    ]);
    setValue(select, "true");
    submit(field(view.container, "scope-provider-enabled-form-account/one"));
    await act(async () => Promise.resolve());
    setValue(select, "false");
    submit(field(view.container, "scope-provider-enabled-form-account/one"));
    await act(async () => Promise.resolve());
    setValue(select, "");
    submit(field(view.container, "scope-provider-enabled-form-account/one"));
    await act(async () => Promise.resolve());
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      body: expect.stringContaining('"enabled":true'),
    });
    expect(fetch.mock.calls[3]?.[1]).toMatchObject({
      body: expect.stringContaining('"enabled":false'),
    });
    expect(fetch.mock.calls[5]?.[1]).toMatchObject({
      body: expect.not.stringContaining("enabled"),
    });
    expect(router.refresh).toHaveBeenCalledTimes(3);
    view.unmount();
  });

  it("uses its explicit disabled default and shows a failed pending save", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(inventory))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (finish = resolve)));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <ScopeProviderEnabledForm
        hostId="host"
        scope={{ repositoryId: "repo/one" }}
        providerAccountId="account/one"
        currentOverride={false}
        inheritedLabel="repository"
      />,
    );
    const form = field<HTMLFormElement>(view.container, "scope-provider-enabled-form-account/one");
    expect(
      field<HTMLSelectElement>(view.container, "scope-provider-enabled-select-account/one").value,
    ).toBe("false");
    submit(form);
    await act(async () => Promise.resolve());
    expect(
      field<HTMLButtonElement>(view.container, "scope-provider-enabled-submit-account/one")
        .disabled,
    ).toBe(true);
    await act(async () => finish(new Response("cannot disable", { status: 409 })));
    expect(field(view.container, "scope-provider-enabled-error-account/one").textContent).toBe(
      "cannot disable",
    );
    const retry = vi
      .fn()
      .mockResolvedValueOnce(json(inventory))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", retry);
    field(view.container, "scope-provider-enabled-select-account/one").remove();
    submit(form);
    await act(async () => Promise.resolve());
    expect(retry.mock.calls[1]?.[1]).toMatchObject({
      body: expect.not.stringContaining("enabled"),
    });
    view.unmount();
  });
});
