// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { type HostUpdateConfig, type mutateHostUpdateConfig } from "@auto-harness/shared";

import { field, mount, press, reset, setValue, submit } from "./action-form-test-helpers.ts";
import { HostUpdateConfigForm } from "./host-update-config-form.tsx";

afterEach(reset);

const updateConfig = {
  enabled: true,
  manifestUrl: "https://updates.example.test/manifest.json",
  publicKey: "-----BEGIN PUBLIC KEY-----\\nkey\\n-----END PUBLIC KEY-----",
  installDir: "/opt/auto-harness",
  pollMs: 60_000,
  daemonVersion: "1.2.3",
} satisfies HostUpdateConfig;

function setTextValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }),
    );
  });
}

describe("HostUpdateConfigForm", () => {
  it("renders every structured updater field and saves a typed host setting", async () => {
    let saved: HostUpdateConfig | undefined;
    const mutateUpdate: typeof mutateHostUpdateConfig = async (hostId, next) => {
      expect(hostId).toBe("host/one");
      saved = next;
      return { ok: true };
    };
    const view = mount(
      <HostUpdateConfigForm
        hostId="host/one"
        updateConfig={updateConfig}
        mutateUpdate={mutateUpdate}
        canWriteExecConfig
      />,
    );
    expect(field(view.container, "host-update-config-alert").textContent).toContain(
      "fleet:exec-config",
    );
    expect(field<HTMLInputElement>(view.container, "host-update-manifest-url").value).toBe(
      updateConfig.manifestUrl,
    );
    expect(field<HTMLTextAreaElement>(view.container, "host-update-public-key").value).toBe(
      "-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----",
    );
    expect(field<HTMLInputElement>(view.container, "host-update-install-dir").value).toBe(
      updateConfig.installDir,
    );
    expect(field<HTMLInputElement>(view.container, "host-update-poll-ms").value).toBe("60000");
    expect(field<HTMLInputElement>(view.container, "host-update-daemon-version").value).toBe(
      "1.2.3",
    );
    setValue(field(view.container, "host-update-poll-ms"), "0");
    await submit(field(view.container, "form-host-update-config"));
    expect(saved).toEqual({ ...updateConfig, pollMs: 0 });
    expect(field(view.container, "host-update-config-ok").textContent).toContain("restart");
    view.unmount();
  });

  it("stores an explicit disabled override and hides writes without authority", async () => {
    let saved: HostUpdateConfig | undefined;
    const view = mount(
      <HostUpdateConfigForm
        hostId="host"
        mutateUpdate={async (_hostId, next) => {
          saved = next;
          return { ok: true };
        }}
        canWriteExecConfig
      />,
    );
    await submit(field(view.container, "form-host-update-config"));
    expect(saved).toEqual({ enabled: false });
    view.unmount();
    expect(
      mount(<HostUpdateConfigForm hostId="host" updateConfig={updateConfig} />).container
        .textContent,
    ).toBe("");
  });

  it("reports validation and mutation failures without saving", async () => {
    const invalid = mount(
      <HostUpdateConfigForm hostId="host" updateConfig={updateConfig} canWriteExecConfig />,
    );
    setValue(field(invalid.container, "host-update-install-dir"), "relative");
    await submit(field(invalid.container, "form-host-update-config"));
    expect(field(document.body, "host-update-config-error").textContent).toContain("absolute");
    invalid.unmount();

    const failed = mount(
      <HostUpdateConfigForm
        hostId="host"
        updateConfig={updateConfig}
        mutateUpdate={async () => ({ ok: false, error: "cannot save" })}
        canWriteExecConfig
      />,
    );
    await submit(field(failed.container, "form-host-update-config"));
    expect(field(document.body, "host-update-config-error").textContent).toBe("cannot save");
    failed.unmount();
  });

  it("tracks every editable field and reports thrown mutation errors", async () => {
    let saved: HostUpdateConfig | undefined;
    const view = mount(
      <HostUpdateConfigForm
        hostId="host"
        updateConfig={{ enabled: false }}
        mutateUpdate={async (_hostId, next) => {
          saved = next;
          return { ok: true };
        }}
        canWriteExecConfig
      />,
    );
    press(field<HTMLInputElement>(view.container, "host-update-enabled"));
    setTextValue(field(view.container, "host-update-manifest-url"), updateConfig.manifestUrl);
    setTextValue(
      field(view.container, "host-update-public-key"),
      "-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----",
    );
    setValue(field(view.container, "host-update-daemon-version"), "2.0.0");
    await submit(field(view.container, "form-host-update-config"));
    expect(saved).toMatchObject({
      enabled: true,
      manifestUrl: updateConfig.manifestUrl,
      publicKey: "-----BEGIN PUBLIC KEY-----\\nkey\\n-----END PUBLIC KEY-----",
      daemonVersion: "2.0.0",
    });
    view.unmount();

    const thrown = mount(
      <HostUpdateConfigForm
        hostId="host"
        updateConfig={updateConfig}
        mutateUpdate={async () => {
          throw new Error("network down");
        }}
        canWriteExecConfig
      />,
    );
    await submit(field(thrown.container, "form-host-update-config"));
    expect(field(document.body, "host-update-config-error").textContent).toBe("network down");
    thrown.unmount();
  });
});
