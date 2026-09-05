// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { TabContent, TabList, TabPanels, TabTrigger } from "./tab-panels.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <TabPanels defaultValue="logs">
        <TabList>
          <TabTrigger value="logs">Logs</TabTrigger>
          <TabTrigger value="details">Details</TabTrigger>
        </TabList>
        <TabContent value="logs" forceMount>
          logs-body
        </TabContent>
        <TabContent value="details">details-body</TabContent>
      </TabPanels>,
    ),
  );
  return { container, unmount: () => act(() => root.unmount()) };
}

afterEach(() => document.body.replaceChildren());

describe("TabPanels", () => {
  it("activates a trigger and keeps force-mounted content in the document", () => {
    const view = mount();
    expect(view.container.querySelector('[data-pw="tab-logs"]')?.getAttribute("data-state")).toBe(
      "active",
    );
    expect(view.container.textContent).toContain("logs-body");
    act(() => {
      (view.container.querySelector('[data-pw="tab-details"]') as HTMLButtonElement).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
    });
    expect(
      view.container.querySelector('[data-pw="tab-details"]')?.getAttribute("data-state"),
    ).toBe("active");
    expect(view.container.textContent).toContain("details-body");
    expect(view.container.textContent).toContain("logs-body");
    view.unmount();
  });
});
