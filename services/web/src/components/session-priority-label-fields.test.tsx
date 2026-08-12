// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { field, mountForm, setValue } from "./form-test-helpers.tsx";
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
    const view = mountForm(<SessionPriorityLabelFields availableLabels={["codex", "gpu"]} />);
    expect(field<HTMLInputElement>(view.container, "create-session-label-codex").value).toBe(
      "codex",
    );
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
