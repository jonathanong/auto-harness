import { describe, expect, it } from "vitest";

import {
  attachProviderAccountToHost,
  detachProviderAccountFromHost,
  setHostProviderAccountCommand,
} from "./host-provider-accounts.ts";
import { emptyHostInventory } from "./host-inventory.ts";

describe("attachProviderAccountToHost / detachProviderAccountFromHost", () => {
  it("attaches a new account without disturbing others", () => {
    const inv = emptyHostInventory();
    const next = attachProviderAccountToHost(inv, { providerAccountId: "acct-1" });
    expect(next.providerAccounts).toEqual([{ providerAccountId: "acct-1" }]);
    expect(inv.providerAccounts).toEqual([]);
  });

  it("re-attaching the same account replaces its entry rather than duplicating it", () => {
    let inv = attachProviderAccountToHost(emptyHostInventory(), {
      providerAccountId: "acct-1",
      commandId: "cmd-1",
    });
    inv = attachProviderAccountToHost(inv, { providerAccountId: "acct-1" });
    expect(inv.providerAccounts).toEqual([{ providerAccountId: "acct-1" }]);
  });

  it("detaches an account by id, leaving others intact", () => {
    let inv = attachProviderAccountToHost(emptyHostInventory(), { providerAccountId: "acct-1" });
    inv = attachProviderAccountToHost(inv, { providerAccountId: "acct-2" });
    inv = detachProviderAccountFromHost(inv, "acct-1");
    expect(inv.providerAccounts).toEqual([{ providerAccountId: "acct-2" }]);
  });

  it("detaching an unattached account is a no-op", () => {
    const inv = attachProviderAccountToHost(emptyHostInventory(), { providerAccountId: "acct-1" });
    const next = detachProviderAccountFromHost(inv, "missing");
    expect(next.providerAccounts).toEqual(inv.providerAccounts);
  });
});

describe("setHostProviderAccountCommand", () => {
  it("sets a command override on an attached account", () => {
    const inv = attachProviderAccountToHost(emptyHostInventory(), { providerAccountId: "acct-1" });
    const next = setHostProviderAccountCommand(inv, "acct-1", "cmd-1");
    expect(next.providerAccounts).toEqual([{ providerAccountId: "acct-1", commandId: "cmd-1" }]);
  });

  it("clears a command override when passed undefined", () => {
    const inv = attachProviderAccountToHost(emptyHostInventory(), {
      providerAccountId: "acct-1",
      commandId: "cmd-1",
    });
    const next = setHostProviderAccountCommand(inv, "acct-1", undefined);
    expect(next.providerAccounts).toEqual([{ providerAccountId: "acct-1" }]);
    expect(Object.hasOwn(next.providerAccounts[0]!, "commandId")).toBe(false);
  });

  it("is a no-op for an account not attached to the host", () => {
    const inv = attachProviderAccountToHost(emptyHostInventory(), { providerAccountId: "acct-1" });
    const next = setHostProviderAccountCommand(inv, "missing", "cmd-1");
    expect(next.providerAccounts).toEqual(inv.providerAccounts);
  });
});
