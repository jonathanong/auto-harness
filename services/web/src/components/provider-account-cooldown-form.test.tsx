// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, press, router, setValue, submit } from "./form-test-helpers.tsx";
import { ProviderAccountCooldownForm } from "./provider-account-cooldown-form.tsx";

const account = {
  id: "account/one",
  usageLimitCooldownSeconds: 60,
  usageLimitedUntil: null,
  lastUsageLimitedAt: null,
};
const pausedAccount = {
  ...account,
  usageLimitedUntil: "2099-01-01T00:00:00.000Z",
  lastUsageLimitedAt: "now",
};

describe("ProviderAccountCooldownForm", () => {
  it("shows available health, opens the editor, and cancels it", () => {
    const view = mountForm(<ProviderAccountCooldownForm account={{ id: account.id }} />);
    expect(field(view.container, "provider-account-cooldown-account/one").textContent).toContain(
      "Available",
    );
    expect(
      view.container.querySelector('[data-pw="provider-account-cooldown-clear-account/one"]'),
    ).toBeNull();
    press(field(view.container, "provider-account-cooldown-edit-account/one"));
    expect(
      field<HTMLInputElement>(view.container, "provider-account-cooldown-input-account/one")
        .labels?.[0]?.textContent,
    ).toBe("Cooldown (s)");
    expect(
      field<HTMLInputElement>(view.container, "provider-account-cooldown-input-account/one").value,
    ).toBe("18000");
    press(
      [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel",
      )!,
    );
    expect(
      view.container.querySelector('[data-pw="provider-account-cooldown-form-account/one"]'),
    ).toBeNull();
    view.unmount();
  });

  it("saves an edited cooldown and refreshes", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<ProviderAccountCooldownForm account={account} />);
    press(field(view.container, "provider-account-cooldown-edit-account/one"));
    setValue(field(view.container, "provider-account-cooldown-input-account/one"), "90");
    submit(field(view.container, "provider-account-cooldown-form-account/one"));
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/provider-accounts/account%2Fone",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ usageLimitCooldownSeconds: 90 }),
      }),
    );
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("uses the default cooldown and keeps its editor open after a save error", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("bad cooldown", { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<ProviderAccountCooldownForm account={account} />);
    press(field(view.container, "provider-account-cooldown-edit-account/one"));
    const form = field<HTMLFormElement>(
      view.container,
      "provider-account-cooldown-form-account/one",
    );
    field(view.container, "provider-account-cooldown-input-account/one").remove();
    submit(form);
    await act(async () => Promise.resolve());
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ usageLimitCooldownSeconds: 18000 }),
    });
    expect(view.container.textContent).toContain("bad cooldown");
    view.unmount();
  });

  it("clears a paused account, disables while pending, and displays a clear failure", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (finish = resolve)));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<ProviderAccountCooldownForm account={pausedAccount} />);
    expect(field(view.container, "provider-account-cooldown-account/one").textContent).toContain(
      "Paused until",
    );
    press(field(view.container, "provider-account-cooldown-clear-account/one"));
    expect(
      field<HTMLButtonElement>(view.container, "provider-account-cooldown-clear-account/one")
        .disabled,
    ).toBe(true);
    await act(async () => finish(new Response("cannot clear", { status: 500 })));
    expect(
      field(view.container, "provider-account-cooldown-clear-error-account/one").textContent,
    ).toBe("cannot clear");
    view.unmount();
  });

  it("refreshes after clearing a paused account", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<ProviderAccountCooldownForm account={pausedAccount} />);
    press(field(view.container, "provider-account-cooldown-clear-account/one"));
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledWith("/api/v1/provider-accounts/account%2Fone/usage-limit", {
      method: "DELETE",
    });
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });
});
