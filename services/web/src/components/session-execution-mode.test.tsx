// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, press } from "../../test-helpers/form-test-helpers.tsx";
import { SessionExecutionMode } from "./session-execution-mode.tsx";

describe("SessionExecutionMode", () => {
  it("reflects the selected location and reports radio changes", () => {
    const onModeChange = vi.fn();
    const view = mountForm(<SessionExecutionMode mode="repository" onModeChange={onModeChange} />);
    const repository = field<HTMLInputElement>(view.container, "create-session-mode-repository");
    const workspace = field<HTMLInputElement>(view.container, "create-session-mode-workspace");

    expect(repository.checked).toBe(true);
    expect(workspace.checked).toBe(false);
    press(workspace);
    expect(onModeChange).toHaveBeenCalledWith("workspace");
    view.unmount();
  });
});
