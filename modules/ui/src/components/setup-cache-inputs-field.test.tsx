// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { field, mount } from "../../test-helpers/action-form-test-helpers.ts";
import { SetupCacheInputsField } from "./setup-cache-inputs-field.tsx";

describe("SetupCacheInputsField", () => {
  it("renders the declared extra paths label and value", () => {
    const view = mount(
      <SetupCacheInputsField
        id="setup-cache"
        dataPw="setup-cache-inputs"
        defaultValue="pnpm-lock.yaml"
      />,
    );
    expect(field<HTMLTextAreaElement>(view.container, "setup-cache-inputs").value).toBe(
      "pnpm-lock.yaml",
    );
    expect(view.container.textContent).toContain("Setup Cache Inputs");
    view.unmount();
  });

  it("renders an operator-declared host-absolute label", () => {
    const view = mount(
      <SetupCacheInputsField
        id="host-abs"
        name="setupCacheHostInputs"
        dataPw="host-setup-cache-host-inputs"
        label="Setup Cache Host Inputs"
        tip="Absolute host-owned file paths."
        defaultValue="/opt/auto-harness/setup/host-environment"
      />,
    );
    expect(field<HTMLTextAreaElement>(view.container, "host-setup-cache-host-inputs").value).toBe(
      "/opt/auto-harness/setup/host-environment",
    );
    expect(view.container.textContent).toContain("Setup Cache Host Inputs");
    view.unmount();
  });

  it("renders an empty uncontrolled field and a controlled value", () => {
    const empty = mount(<SetupCacheInputsField id="empty" dataPw="empty-cache" />);
    expect(field<HTMLTextAreaElement>(empty.container, "empty-cache").value).toBe("");
    empty.unmount();
    const controlled = mount(
      <SetupCacheInputsField
        id="controlled"
        dataPw="controlled-cache"
        value="Cargo.lock"
        onChange={() => undefined}
      />,
    );
    expect(field<HTMLTextAreaElement>(controlled.container, "controlled-cache").value).toBe(
      "Cargo.lock",
    );
    controlled.unmount();
  });
});
