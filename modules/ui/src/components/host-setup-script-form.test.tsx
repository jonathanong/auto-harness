// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { type HostInventory, type mutateInventory } from "@auto-harness/shared";

import { field, mount, reset, router, setValue, submit } from "./action-form-test-helpers.ts";
import { HostSetupScriptForm } from "./host-setup-script-form.tsx";

afterEach(reset);

const current: HostInventory = {
  repositories: [{ id: "repo", path: "/repo", defaultBranch: "main", worktrees: [] }],
  providerAccounts: [],
};

const failedMutation: typeof mutateInventory = async () => ({
  ok: false,
  error: "cannot save",
});

const rejectedMutation: typeof mutateInventory = async () => {
  throw new Error("offline");
};

describe("HostSetupScriptForm", () => {
  it("updates only the host setup script and refreshes", async () => {
    let written: HostInventory | undefined;
    const calls: string[] = [];
    const mutate: typeof mutateInventory = async (hostId, transform) => {
      calls.push(hostId);
      written = transform(current);
      return { ok: true };
    };
    const view = mount(<HostSetupScriptForm hostId="host/one" setupScript="old" mutate={mutate} />);
    expect(field<HTMLTextAreaElement>(view.container, "host-setup-script").value).toBe("old");
    setValue(field(view.container, "host-setup-script"), "source ~/.zshrc");
    await submit(field(view.container, "form-host-setup-script"));
    expect(calls).toEqual(["host/one"]);
    expect(written).toEqual({ ...current, setupScript: "source ~/.zshrc", capabilities: [] });
    expect(field(view.container, "host-setup-script-ok").textContent).toBe("Saved.");
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("surfaces mutation failures", async () => {
    const view = mount(<HostSetupScriptForm hostId="host" mutate={failedMutation} />);
    await submit(field(view.container, "form-host-setup-script"));
    expect(field(document.body, "host-setup-script-error").textContent).toBe("cannot save");
    expect(router.refresh).not.toHaveBeenCalled();
    view.unmount();

    const rejected = mount(<HostSetupScriptForm hostId="host" mutate={rejectedMutation} />);
    await submit(field(rejected.container, "form-host-setup-script"));
    expect(field(document.body, "host-setup-script-error").textContent).toBe("offline");
    rejected.unmount();
  });
});
