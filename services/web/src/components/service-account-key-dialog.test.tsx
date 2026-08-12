// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, press } from "./form-test-helpers.tsx";
import { ServiceAccountKeyDialog } from "./service-account-key-dialog.tsx";

const secret = {
  account: { id: "service:new", name: "ci", role: "operator" as const, createdAt: "now" },
  apiKey: "hns_one-time",
};

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ServiceAccountKeyDialog", () => {
  it("copies the one-time key and dismisses it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const onDismiss = vi.fn();
    mountForm(
      <ServiceAccountKeyDialog secret={secret} onDismiss={onDismiss} onRevokeOld={vi.fn()} />,
    );
    expect(field(document.body, "service-account-key-warning").textContent).toContain("shown once");
    press(field(document.body, "service-account-copy-key"));
    await settle();
    expect(writeText).toHaveBeenCalledWith("hns_one-time");
    expect(field(document.body, "service-account-copy-ok").textContent).toBe("Copied.");
    press(field(document.body, "service-account-key-done"));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("keeps the old key active until consumers are confirmed and then revokes it", async () => {
    const onRevokeOld = vi.fn().mockResolvedValue(undefined);
    mountForm(
      <ServiceAccountKeyDialog
        secret={secret}
        rotatedFromId="service:old"
        onDismiss={vi.fn()}
        onRevokeOld={onRevokeOld}
      />,
    );
    const revoke = field<HTMLButtonElement>(document.body, "rotation-revoke-old");
    expect(revoke.disabled).toBe(true);
    press(field(document.body, "rotation-consumers-updated"));
    expect(revoke.disabled).toBe(false);
    press(revoke);
    await settle();
    expect(onRevokeOld).toHaveBeenCalledWith("service:old");
  });

  it("reports copy and revoke failures, including non-error failures", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) },
    });
    const onRevokeOld = vi
      .fn()
      .mockRejectedValueOnce(new Error("still connected"))
      .mockRejectedValueOnce("offline");
    mountForm(
      <ServiceAccountKeyDialog
        secret={secret}
        rotatedFromId="service:old"
        onDismiss={vi.fn()}
        onRevokeOld={onRevokeOld}
      />,
    );
    press(field(document.body, "service-account-copy-key"));
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("manually");
    press(field(document.body, "rotation-consumers-updated"));
    press(field(document.body, "rotation-revoke-old"));
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe("still connected");
    press(field(document.body, "rotation-revoke-old"));
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      "Unable to revoke old key.",
    );
  });

  it("dismisses when the dialog close control changes its open state", () => {
    const onDismiss = vi.fn();
    mountForm(
      <ServiceAccountKeyDialog secret={secret} onDismiss={onDismiss} onRevokeOld={vi.fn()} />,
    );
    press(field(document.body, "dialog-close"));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
