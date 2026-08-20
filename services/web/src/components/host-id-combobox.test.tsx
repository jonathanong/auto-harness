// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm, setValue } from "./form-test-helpers.tsx";
import { HostIdCombobox } from "./host-id-combobox.tsx";

const hostIds = ["alpha", "beta", "gamma"];

function key(element: HTMLElement, keyName: string) {
  const event = new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true });
  act(() => element.dispatchEvent(event));
  return event;
}

describe("HostIdCombobox", () => {
  it("filters existing hosts and selects from the list", () => {
    const view = mountForm(
      <HostIdCombobox id="host" name="hostId" dataPw="host-picker" hostIds={hostIds} />,
    );
    const input = field<HTMLInputElement>(view.container, "host-picker");
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    act(() => input.focus());
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(3);
    key(input, "ArrowDown");
    key(input, "ArrowDown");
    setValue(input, "et");
    const options = [...view.container.querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual(["beta"]);
    expect(view.container.querySelector('[aria-selected="true"]')?.textContent).toBe("beta");
    act(() => options[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(input.value).toBe("beta");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    act(() => input.focus());
    setValue(input, " ");
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(3);
    view.unmount();
  });

  it("navigates, selects, and dismisses with the keyboard", () => {
    const view = mountForm(
      <HostIdCombobox
        id="host"
        name="hostId"
        dataPw="host-picker"
        hostIds={hostIds}
        required
        defaultValue="alpha"
      />,
    );
    const input = field<HTMLInputElement>(view.container, "host-picker");
    expect(input.required).toBe(true);
    expect(input.value).toBe("alpha");
    const closedEnter = key(input, "Enter");
    expect(closedEnter.defaultPrevented).toBe(false);
    const closedDown = key(input, "ArrowDown");
    expect(closedDown.defaultPrevented).toBe(true);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelector('[aria-selected="true"]')?.textContent).toBe("alpha");
    key(input, "ArrowDown");
    expect(view.container.querySelector('[aria-selected="true"]')?.textContent).toBe("beta");
    key(input, "ArrowDown");
    key(input, "ArrowDown");
    expect(view.container.querySelector('[aria-selected="true"]')?.textContent).toBe("alpha");
    key(input, "ArrowUp");
    expect(view.container.querySelector('[aria-selected="true"]')?.textContent).toBe("gamma");
    const ignored = key(input, "Home");
    expect(ignored.defaultPrevented).toBe(false);
    const enter = key(input, "Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(input.value).toBe("gamma");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      input.blur();
      input.focus();
    });
    expect(input.getAttribute("aria-expanded")).toBe("true");
    key(input, "Escape");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    act(() => input.blur());
    expect(input.getAttribute("aria-expanded")).toBe("false");
    view.unmount();
  });

  it("stays closed when nothing matches", () => {
    const empty = mountForm(
      <HostIdCombobox id="empty" name="hostId" dataPw="empty-picker" hostIds={[]} />,
    );
    const emptyInput = field<HTMLInputElement>(empty.container, "empty-picker");
    act(() => emptyInput.focus());
    expect(emptyInput.getAttribute("aria-expanded")).toBe("false");
    empty.unmount();
    const view = mountForm(
      <HostIdCombobox id="host" name="hostId" dataPw="host-picker" hostIds={["only"]} />,
    );
    const input = field<HTMLInputElement>(view.container, "host-picker");
    setValue(input, "zzz");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.validationMessage).toBe("Select a host from the list");
    expect(view.container.querySelector('[role="option"]')).toBeNull();
    const down = key(input, "ArrowDown");
    expect(down.defaultPrevented).toBe(false);
    key(input, "ArrowUp");
    const enter = key(input, "Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(input.value).toBe("");
    setValue(input, "zzz");
    act(() => {
      input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      input.blur();
    });
    expect(input.value).toBe("");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    setValue(input, "only");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    view.unmount();
  });

  it("restores the default value when the enclosing form resets", () => {
    const view = mountForm(
      <form data-pw="host-form">
        <HostIdCombobox
          id="host"
          name="hostId"
          dataPw="host-picker"
          hostIds={hostIds}
          defaultValue="alpha"
        />
      </form>,
    );
    const input = field<HTMLInputElement>(view.container, "host-picker");
    setValue(input, "gamma");
    act(() => field<HTMLFormElement>(view.container, "host-form").reset());
    expect(input.value).toBe("alpha");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    view.unmount();
  });
});
