// @vitest-environment happy-dom

import { createRoot } from "react-dom/client";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { Switch } from "./switch.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    unmount: () => act(() => root.unmount()),
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("Switch", () => {
  it("renders accessible form attributes and checked state", () => {
    const markup = renderToStaticMarkup(
      <Switch
        name="requiredLabels"
        value="codex"
        defaultChecked
        disabled
        className="switch-marker"
        aria-label="codex"
      />,
    );
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('aria-label="codex"');
    expect(markup).toContain('value="codex"');
    expect(markup).toContain('name="requiredLabels"');
    expect(markup).toContain("switch-marker");
    expect(markup).toContain("disabled");
  });

  it("toggles a named switch and only submits the checked value", () => {
    const view = mount(
      <form>
        <Switch name="requiredLabels" value="gpu" className="switch-marker" data-pw="gpu-switch" />
      </form>,
    );
    const control = view.container.querySelector('[data-pw="gpu-switch"]') as HTMLButtonElement;
    const form = view.container.querySelector("form") as HTMLFormElement;
    expect(control.getAttribute("role")).toBe("switch");
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(control.className).toContain("switch-marker");
    expect(new FormData(form).getAll("requiredLabels")).toEqual([]);

    act(() => control.click());
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(new FormData(form).getAll("requiredLabels")).toEqual(["gpu"]);

    act(() => control.click());
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(new FormData(form).getAll("requiredLabels")).toEqual([]);
    view.unmount();
  });
});
