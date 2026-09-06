// @vitest-environment happy-dom

import { useRef, useState } from "react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { field, mount, reset } from "./action-form-test-helpers.ts";
import { useLogStickBottom } from "./use-log-stick-bottom.ts";

afterEach(reset);

function Probe({ enabled, value }: { enabled: boolean; value: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLogStickBottom(ref, value, enabled);
  return (
    <div ref={ref} data-pw="scroller">
      {value}
    </div>
  );
}

function Harness() {
  const [enabled, setEnabled] = useState(true);
  const [value, setValue] = useState("one");
  return (
    <div>
      <button type="button" data-pw="disable" onClick={() => setEnabled(false)}>
        disable
      </button>
      <button
        type="button"
        data-pw="append"
        onClick={() => setValue((current) => `${current}\ntwo`)}
      >
        append
      </button>
      <Probe enabled={enabled} value={value} />
    </div>
  );
}

describe("useLogStickBottom", () => {
  it("sticks to the bottom after the first update unless the user scrolled away", () => {
    const view = mount(<Harness />);
    const scroller = field(view.container, "scroller");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 200 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 40 });
    scroller.scrollTop = 0;
    act(() => field(view.container, "append").click());
    expect(scroller.scrollTop).toBe(200);
    scroller.scrollTop = 0;
    act(() => scroller.dispatchEvent(new Event("scroll")));
    act(() => field(view.container, "append").click());
    expect(scroller.scrollTop).toBe(0);
    act(() => field(view.container, "disable").click());
    act(() => field(view.container, "append").click());
    expect(scroller.scrollTop).toBe(0);
  });
});
