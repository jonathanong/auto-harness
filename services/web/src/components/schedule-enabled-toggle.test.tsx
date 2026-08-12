// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, press, router } from "./form-test-helpers.tsx";
import { ScheduleEnabledToggle } from "./schedule-enabled-toggle.tsx";

function toggle(view: ReturnType<typeof mountForm>, id = "schedule/1") {
  return field<HTMLButtonElement>(view.container, `schedule-enabled-${id}`);
}

describe("ScheduleEnabledToggle", () => {
  it("disables an enabled schedule and refreshes", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<ScheduleEnabledToggle id="schedule/1" enabled />);
    expect(toggle(view).getAttribute("role")).toBe("switch");
    expect(toggle(view).getAttribute("aria-checked")).toBe("true");
    expect(toggle(view).getAttribute("aria-busy")).toBe("false");
    expect(toggle(view).textContent).toContain("Enabled");

    press(toggle(view));
    await act(async () => Promise.resolve());

    expect(fetch).toHaveBeenCalledWith("/api/v1/schedules/schedule%2F1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("keeps a failed toggle actionable and reports the intended change", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))),
    );
    const view = mountForm(<ScheduleEnabledToggle id="schedule/1" enabled={false} />);
    expect(toggle(view).getAttribute("aria-checked")).toBe("false");
    expect(toggle(view).getAttribute("aria-label")).toBe("Enable schedule");
    press(toggle(view));
    expect(toggle(view).disabled).toBe(true);
    expect(toggle(view).getAttribute("aria-busy")).toBe("true");
    expect(toggle(view).textContent).toContain("Saving…");

    await act(async () => finish(new Response("failed", { status: 500 })));

    expect(router.push).toHaveBeenCalledWith(
      "/schedules?toast=Could+not+enable+schedule.+Try+again.",
    );
    expect(router.refresh).not.toHaveBeenCalled();
    view.unmount();
  });

  it("names a failed disable action", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("failed", { status: 500 })));
    const view = mountForm(<ScheduleEnabledToggle id="schedule/1" enabled />);
    expect(toggle(view).getAttribute("aria-label")).toBe("Disable schedule");
    press(toggle(view));
    await act(async () => Promise.resolve());
    expect(router.push).toHaveBeenCalledWith(
      "/schedules?toast=Could+not+disable+schedule.+Try+again.",
    );
    view.unmount();
  });
});
