/* eslint-disable max-lines -- independent form mutations and refresh behavior share fixtures. */
// @vitest-environment happy-dom

import { act, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type HostExecConfigPatch,
  type HostInventory,
  type mutateExecConfig,
  type mutateInventory,
} from "@auto-harness/shared";

import { field, mount, reset, router, setValue, submit } from "./action-form-test-helpers.ts";
import { HostSetupScriptForm } from "./host-setup-script-form.tsx";

afterEach(reset);

const current: HostInventory = {
  repositories: [{ id: "repo", path: "/repo", defaultBranch: "main", worktrees: [] }],
  providerAccounts: [],
};

const failedExec: typeof mutateExecConfig = async () => ({
  ok: false,
  error: "cannot save",
});

const rejectedExec: typeof mutateExecConfig = async () => {
  throw new Error("offline");
};

const successfulExec: typeof mutateExecConfig = async () => ({ ok: true });
const successfulInv: typeof mutateInventory = async () => ({ ok: true });
const failedInv: typeof mutateInventory = async () => ({ ok: false, error: "env failed" });

function RefreshHarness() {
  const [script, setScript] = useState("old");
  return (
    <>
      <button type="button" data-pw="own-refresh" onClick={() => setScript("saved value")}>
        Own refresh
      </button>
      <button type="button" data-pw="external-refresh" onClick={() => setScript("external value")}>
        External refresh
      </button>
      <HostSetupScriptForm
        hostId="host"
        setupScript={script}
        mutateExec={successfulExec}
        mutateInv={successfulInv}
        canWriteExecConfig
      />
    </>
  );
}

function UnrelatedRefreshHarness() {
  const [environment, setEnvironment] = useState(["TOKEN"]);
  return (
    <>
      <button
        type="button"
        data-pw="unrelated-refresh"
        onClick={() => setEnvironment(["NEXT_TOKEN"])}
      >
        Refresh environment
      </button>
      <HostSetupScriptForm
        hostId="host"
        setupScript="old"
        allowedRoots={["/old-root"]}
        requiredEnvironment={environment}
        mutateExec={successfulExec}
        mutateInv={successfulInv}
        canWriteExecConfig
      />
    </>
  );
}

describe("HostSetupScriptForm", () => {
  it("saves exec-config and required environment through independent forms", async () => {
    let execPatch: HostExecConfigPatch | undefined;
    let written: HostInventory | undefined;
    const mutateExec: typeof mutateExecConfig = async (hostId, patch) => {
      execPatch = patch(current);
      expect(hostId).toBe("host/one");
      return { ok: true };
    };
    const mutateInv: typeof mutateInventory = async (hostId, transform) => {
      expect(hostId).toBe("host/one");
      written = transform(current);
      return { ok: true };
    };
    const view = mount(
      <HostSetupScriptForm
        hostId="host/one"
        setupScript="old"
        allowedRoots={["/opt/harness"]}
        mutateExec={mutateExec}
        mutateInv={mutateInv}
        canWriteExecConfig
      />,
    );
    expect(field(view.container, "host-exec-config-alert").textContent).toContain(
      "fleet:exec-config",
    );
    expect(field<HTMLTextAreaElement>(view.container, "host-setup-script").value).toBe("old");
    expect(field<HTMLTextAreaElement>(view.container, "host-allowed-roots").value).toBe(
      "/opt/harness",
    );
    setValue(field(view.container, "host-setup-script"), "source ~/.zshrc");
    setValue(field(view.container, "host-allowed-roots"), "/opt/harness,with,commas\n/usr/local");
    setValue(field(view.container, "host-required-environment"), " REGION\nTOKEN ");
    await submit(field(view.container, "form-host-setup-script"));
    expect(execPatch).toEqual({
      setupScript: "source ~/.zshrc",
      allowedRoots: ["/opt/harness,with,commas", "/usr/local"],
    });
    expect(written).toBeUndefined();
    expect(field(view.container, "host-setup-script-ok").textContent).toBe("Saved.");
    await submit(field(view.container, "form-host-required-environment"));
    expect(written).toEqual({
      ...current,
      requiredEnvironment: ["REGION", "TOKEN"],
      capabilities: [],
    });
    expect(field(view.container, "host-required-environment-ok").textContent).toBe("Saved.");
    expect(router.refresh).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("surfaces mutation failures and invalid allowed roots", async () => {
    const view = mount(
      <HostSetupScriptForm
        hostId="host"
        mutateExec={failedExec}
        mutateInv={successfulInv}
        canWriteExecConfig
      />,
    );
    setValue(field(view.container, "host-setup-script"), "change");
    await submit(field(view.container, "form-host-setup-script"));
    expect(field(document.body, "host-setup-script-error").textContent).toBe("cannot save");
    expect(router.refresh).not.toHaveBeenCalled();
    view.unmount();

    const rejected = mount(
      <HostSetupScriptForm
        hostId="host"
        mutateExec={rejectedExec}
        mutateInv={successfulInv}
        canWriteExecConfig
      />,
    );
    setValue(field(rejected.container, "host-setup-script"), "change");
    await submit(field(rejected.container, "form-host-setup-script"));
    expect(field(document.body, "host-setup-script-error").textContent).toBe("offline");
    rejected.unmount();

    const invalid = mount(
      <HostSetupScriptForm
        hostId="host"
        mutateExec={successfulExec}
        mutateInv={successfulInv}
        canWriteExecConfig
      />,
    );
    setValue(field(invalid.container, "host-allowed-roots"), "relative");
    await submit(field(invalid.container, "form-host-setup-script"));
    expect(field(document.body, "host-setup-script-error").textContent).toContain("absolute");
    invalid.unmount();

    const envFail = mount(
      <HostSetupScriptForm
        hostId="host"
        mutateExec={successfulExec}
        mutateInv={failedInv}
        canWriteExecConfig
      />,
    );
    await submit(field(envFail.container, "form-host-required-environment"));
    expect(field(document.body, "host-required-environment-error").textContent).toBe("env failed");
    envFail.unmount();
  });

  it("hides exec-config fields without the capability and still saves inventory", async () => {
    let inventoryCalls = 0;
    const mutateInv: typeof mutateInventory = async () => {
      inventoryCalls += 1;
      return { ok: true };
    };
    const view = mount(
      <HostSetupScriptForm
        hostId="host"
        canWriteExecConfig={false}
        mutateInv={mutateInv}
        requiredEnvironment={["TOKEN"]}
      />,
    );
    expect(view.container.querySelector('[data-pw="host-setup-script"]')).toBeNull();
    expect(view.container.querySelector('[data-pw="host-exec-config-alert"]')).toBeNull();
    await submit(field(view.container, "form-host-required-environment"));
    expect(inventoryCalls).toBe(1);
    view.unmount();

    expect(
      mount(
        <HostSetupScriptForm hostId="host" canWriteExecConfig={false} canWriteInventory={false} />,
      ).container.textContent,
    ).toBe("");

    const execOnly = mount(
      <HostSetupScriptForm
        hostId="host"
        canWriteInventory={false}
        canWriteExecConfig
        mutateExec={successfulExec}
      />,
    );
    expect(execOnly.container.querySelector('[data-pw="host-required-environment"]')).toBeNull();
    execOnly.unmount();
  });

  it("preserves Saved through its own refresh, then syncs and clears it externally", async () => {
    const view = mount(<RefreshHarness />);
    const textarea = field<HTMLTextAreaElement>(view.container, "host-setup-script");
    setValue(textarea, "saved value");
    await submit(field(view.container, "form-host-setup-script"));
    expect(field(view.container, "host-setup-script-ok").textContent).toBe("Saved.");

    act(() => field<HTMLButtonElement>(view.container, "own-refresh").click());
    expect(textarea.value).toBe("saved value");
    expect(field(view.container, "host-setup-script-ok").textContent).toBe("Saved.");

    act(() => field<HTMLButtonElement>(view.container, "external-refresh").click());
    expect(textarea.value).toBe("external value");
    expect(view.container.querySelector('[data-pw="host-setup-script-ok"]')).toBeNull();
    view.unmount();
  });

  it("patches only fields edited in the exec form, preserving freshly read siblings", async () => {
    let execPatch: HostExecConfigPatch | undefined;
    const mutateExec: typeof mutateExecConfig = async (_hostId, patch) => {
      execPatch = patch({ ...current, allowedRoots: ["/newer-root"] });
      return { ok: true };
    };
    const view = mount(
      <HostSetupScriptForm
        hostId="host"
        setupScript="old"
        allowedRoots={["/old-root"]}
        mutateExec={mutateExec}
        canWriteExecConfig
        canWriteInventory={false}
      />,
    );
    setValue(field(view.container, "host-setup-script"), "new script");
    await submit(field(view.container, "form-host-setup-script"));
    expect(execPatch).toEqual({ setupScript: "new script" });
    view.unmount();
  });

  it("preserves dirty exec fields across an unrelated inventory refresh", () => {
    const view = mount(<UnrelatedRefreshHarness />);
    setValue(field(view.container, "host-setup-script"), "new script");
    setValue(field(view.container, "host-allowed-roots"), "/new-root");

    act(() => field<HTMLButtonElement>(view.container, "unrelated-refresh").click());

    expect(field<HTMLTextAreaElement>(view.container, "host-setup-script").value).toBe(
      "new script",
    );
    expect(field<HTMLTextAreaElement>(view.container, "host-allowed-roots").value).toBe(
      "/new-root",
    );
    view.unmount();
  });
});
