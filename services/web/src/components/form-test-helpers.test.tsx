// @vitest-environment happy-dom

import React, { useState } from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm, setValue } from "./form-test-helpers.tsx";

function ControlledInput() {
  const [value, setCurrentValue] = useState("");
  return (
    <input
      data-pw="controlled"
      value={value}
      onChange={(event) => setCurrentValue(event.target.value)}
    />
  );
}

describe("form test helpers", () => {
  it("updates a controlled text input through React onChange", () => {
    const view = mountForm(<ControlledInput />);
    const input = field<HTMLInputElement>(view.container, "controlled");
    setValue(input, "updated");
    expect(input.value).toBe("updated");
    view.unmount();
  });
});
