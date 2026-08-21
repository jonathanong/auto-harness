// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { field, mountForm, press, setValue } from "./form-test-helpers.tsx";
import { SessionPriorityLabelFields } from "./session-priority-label-fields.tsx";

describe("SessionPriorityLabelFields", () => {
  it("shows the any-worktree state when online worktrees advertise no labels", () => {
    const view = mountForm(<SessionPriorityLabelFields availableLabels={[]} />);
    expect(field(view.container, "create-session-priority-value").textContent).toBe("0 (low)");
    expect(field(view.container, "create-session-labels-empty").textContent).toContain(
      "any worktree",
    );
    view.unmount();
  });

  it("renders selectable labels and describes every priority band", () => {
    const view = mountForm(
      <form>
        <SessionPriorityLabelFields
          availableLabels={["codex", "gpu"]}
          initialRequiredLabels={["gpu"]}
        />
      </form>,
    );
    const form = view.container.querySelector("form") as HTMLFormElement;
    const codex = field<HTMLButtonElement>(view.container, "create-session-label-codex");
    const gpu = field<HTMLButtonElement>(view.container, "create-session-label-gpu");
    expect(codex.value).toBe("codex");
    expect(codex.getAttribute("role")).toBe("switch");
    expect(codex.getAttribute("aria-checked")).toBe("false");
    expect(gpu.getAttribute("aria-checked")).toBe("true");
    expect(form.querySelectorAll('input[name="requiredLabels"]')).toHaveLength(2);
    expect(new FormData(form).getAll("requiredLabels")).toEqual(["gpu"]);
    press(codex);
    expect(codex.getAttribute("aria-checked")).toBe("true");
    expect(new FormData(form).getAll("requiredLabels")).toEqual(["codex", "gpu"]);
    const priority = field<HTMLInputElement>(view.container, "create-session-priority");
    for (const [value, label] of [
      ["25", "25 (normal)"],
      ["50", "50 (high)"],
      ["75", "75 (critical)"],
    ]) {
      setValue(priority, value);
      expect(field(view.container, "create-session-priority-value").textContent).toBe(label);
    }
    view.unmount();
  });
});
