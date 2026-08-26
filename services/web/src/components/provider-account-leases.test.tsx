// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ProviderAccountLeaseState } from "@auto-harness/shared";

import { field, json, mountForm, press, router } from "./form-test-helpers.tsx";
import { ProviderAccountLeases } from "./provider-account-leases.tsx";

function lease(
  patch: Partial<NonNullable<ProviderAccountLeaseState["holder"]>> = {},
): ProviderAccountLeaseState {
  return {
    providerAccountId: "account/one",
    slot: 2,
    holder: {
      sessionId: "session-one",
      attemptId: "attempt-one",
      hostId: "host-one",
      sessionStatus: "cancelled",
      sessionCreatedAt: "2026-08-25T00:00:00.000Z",
      sessionStartedAt: "2026-08-25T00:01:00.000Z",
      releasable: true,
      releaseBlock: null,
      ...patch,
    },
  };
}

describe("ProviderAccountLeases", () => {
  it("renders empty and failed lease reads", () => {
    const empty = mountForm(<ProviderAccountLeases accountId="account" leases={[]} />);
    expect(empty.container.textContent).toContain("No held leases");
    empty.unmount();
    const failed = mountForm(<ProviderAccountLeases accountId="account" leases={null} />);
    expect(failed.container.textContent).toContain("Could not load held leases");
  });

  it("shows holder details and disables unsafe release", () => {
    const view = mountForm(
      <ProviderAccountLeases
        accountId="account"
        leases={[
          lease({
            hostId: null,
            sessionStatus: "running",
            sessionStartedAt: null,
            releasable: false,
            releaseBlock: "session_not_terminal",
          }),
        ]}
      />,
    );
    expect(view.container.textContent).toContain("session-one");
    expect(view.container.textContent).toContain("running");
    expect(
      field<HTMLButtonElement>(view.container, "provider-account-lease-release-account-2").disabled,
    ).toBe(true);
    view.unmount();

    const attached = mountForm(
      <ProviderAccountLeases
        accountId="account"
        leases={[lease({ releasable: false, releaseBlock: "session_assignment_attached" })]}
      />,
    );
    expect(
      field<HTMLButtonElement>(attached.container, "provider-account-lease-release-account-2")
        .disabled,
    ).toBe(true);
  });

  it("confirms a terminal release, refreshes, and reports immediate reuse", async () => {
    const fetch = vi.fn().mockResolvedValue(
      json({
        released: true,
        before: lease(),
        after: lease({ sessionId: "session-two", attemptId: "attempt-two" }),
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<ProviderAccountLeases accountId="account/one" leases={[lease()]} />);
    press(field(view.container, "provider-account-lease-release-account/one-2"));
    expect(
      field(document.body, "provider-account-lease-release-account/one-2-confirm").textContent,
    ).toContain("terminal Session session-one");
    press(field(document.body, "provider-account-lease-release-account/one-2-confirm-submit"));
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledWith("/api/v1/provider-accounts/account%2Fone/leases/2/release", {
      method: "POST",
    });
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("immediately claimed");
  });

  it("keeps confirmation open when release is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json({ error: { code: "CONFLICT", message: "lease changed concurrently" } }, 409),
        ),
    );
    const view = mountForm(<ProviderAccountLeases accountId="account/one" leases={[lease()]} />);
    press(field(view.container, "provider-account-lease-release-account/one-2"));
    press(field(document.body, "provider-account-lease-release-account/one-2-confirm-submit"));
    await act(async () => Promise.resolve());
    expect(
      field(document.body, "provider-account-lease-release-account/one-2-error").textContent,
    ).toBe("lease changed concurrently");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("renders missing and mismatched holder safeguards", () => {
    const view = mountForm(
      <ProviderAccountLeases
        accountId="account"
        leases={[
          lease({
            sessionStatus: null,
            sessionCreatedAt: null,
            sessionStartedAt: null,
            releasable: false,
            releaseBlock: "session_not_found",
          }),
          { ...lease({ releasable: false, releaseBlock: "session_lease_mismatch" }), slot: 3 },
        ]}
      />,
    );
    expect(view.container.textContent).toContain("Session missing");
    expect(
      field<HTMLButtonElement>(view.container, "provider-account-lease-release-account-3").disabled,
    ).toBe(true);
  });

  it.each([
    {
      name: "an already-free slot",
      result: {
        released: false,
        before: { providerAccountId: "account/one", slot: 2, holder: null },
        after: { providerAccountId: "account/one", slot: 2, holder: null },
      },
      message: "already free",
    },
    {
      name: "a released slot",
      result: {
        released: true,
        before: lease(),
        after: { providerAccountId: "account/one", slot: 2, holder: null },
      },
      message: "lease released",
    },
  ])("reports $name", async ({ result, message }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(result)));
    const view = mountForm(<ProviderAccountLeases accountId="account/one" leases={[lease()]} />);
    press(field(view.container, "provider-account-lease-release-account/one-2"));
    press(field(document.body, "provider-account-lease-release-account/one-2-confirm-submit"));
    await act(async () => Promise.resolve());
    expect(document.body.textContent?.toLowerCase()).toContain(message);
  });

  it("ignores free slot states in a held-lease response", () => {
    const view = mountForm(
      <ProviderAccountLeases
        accountId="account"
        leases={[{ providerAccountId: "account", slot: 0, holder: null }]}
      />,
    );
    expect(view.container.textContent).toContain("No held leases");
  });
});
