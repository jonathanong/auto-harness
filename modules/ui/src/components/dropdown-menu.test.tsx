// @vitest-environment happy-dom

import { createRoot } from "react-dom/client";
import { act, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { unmount: () => act(() => root.unmount()) };
}

function ExampleMenu({ marked }: { marked: boolean }) {
  const [open, setOpen] = useState(true);
  const content = marked ? (
    <DropdownMenuContent className="menu-marker" sideOffset={8} data-pw="menu-content">
      <DropdownMenuItem className="item-marker" data-pw="menu-sessions">
        Sessions
      </DropdownMenuItem>
    </DropdownMenuContent>
  ) : (
    <DropdownMenuContent data-pw="menu-content">
      <DropdownMenuItem data-pw="menu-sessions">Sessions</DropdownMenuItem>
    </DropdownMenuContent>
  );
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger data-pw="menu-trigger">Operate</DropdownMenuTrigger>
      {content}
    </DropdownMenu>
  );
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("dropdown menu", () => {
  it("renders default and custom content styles and closes on item click", () => {
    const unmarked = mount(<ExampleMenu marked={false} />);
    expect(document.body.querySelector('[data-pw="menu-content"]')?.className).not.toContain(
      "menu-marker",
    );
    unmarked.unmount();

    const view = mount(<ExampleMenu marked />);
    const content = document.body.querySelector('[data-pw="menu-content"]');
    if (!content) throw new Error("menu content did not render");
    expect(content.className).toContain("menu-marker");
    const item = content.querySelector('[data-pw="menu-sessions"]');
    if (!item) throw new Error("menu item did not render");
    expect(item.className).toContain("item-marker");
    expect(content.textContent).toContain("Sessions");
    act(() => (item as HTMLElement).click());
    expect(document.body.querySelector('[data-pw="menu-content"]')).toBeNull();
    view.unmount();
  });
});
