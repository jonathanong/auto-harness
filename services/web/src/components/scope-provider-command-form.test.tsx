// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, json, mountForm, router, setValue, submit } from "./form-test-helpers.tsx";
import { ScopeProviderCommandForm } from "./scope-provider-command-form.tsx";

const inventory = {
  repositories: [{ id: "repo/one", path: "/repo", defaultBranch: "main", worktrees: [] }],
  providerAccounts: [{ providerAccountId: "account/one" }],
  commandProfiles: {},
};
const commands = [
  { id: "command/one", name: "Claude", argv: ["claude"], appendPrompt: true, providerId: "p" },
] as const;

describe("ScopeProviderCommandForm", () => {
  it("selects and saves a provider command", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(inventory))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <ScopeProviderCommandForm
        hostId="host/one"
        scope={{ repositoryId: "repo/one" }}
        providerAccountId="account/one"
        currentOverride={undefined}
        providerCommands={[...commands]}
      />,
    );
    const select = field<HTMLSelectElement>(
      view.container,
      "scope-provider-command-select-account/one",
    );
    expect([...select.options].map((option) => option.text)).toEqual(["(inherit)", "Claude"]);
    setValue(select, "command/one");
    submit(field(view.container, "scope-provider-command-form-account/one"));
    await act(async () => Promise.resolve());
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      body: expect.stringContaining('"commandId":"command/one"'),
    });
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("inherits from an existing override and reports a failed pending save", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(inventory))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (finish = resolve)));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <ScopeProviderCommandForm
        hostId="host"
        scope={{ repositoryId: "repo/one" }}
        providerAccountId="account/one"
        currentOverride="command/one"
        providerCommands={[...commands]}
      />,
    );
    const form = field<HTMLFormElement>(view.container, "scope-provider-command-form-account/one");
    const select = field<HTMLSelectElement>(
      view.container,
      "scope-provider-command-select-account/one",
    );
    expect(select.value).toBe("command/one");
    setValue(select, "");
    submit(form);
    await act(async () => Promise.resolve());
    expect(
      field<HTMLButtonElement>(view.container, "scope-provider-command-submit-account/one")
        .disabled,
    ).toBe(true);
    await act(async () => finish(new Response("command unavailable", { status: 422 })));
    expect(field(view.container, "scope-provider-command-error-account/one").textContent).toBe(
      "command unavailable",
    );
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      body: expect.not.stringContaining("commandId"),
    });
    const retry = vi
      .fn()
      .mockResolvedValueOnce(json(inventory))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", retry);
    select.remove();
    submit(form);
    await act(async () => Promise.resolve());
    expect(retry.mock.calls[1]?.[1]).toMatchObject({
      body: expect.not.stringContaining("commandId"),
    });
    view.unmount();
  });
});
