// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { mountForm, press, router } from "./form-test-helpers.tsx";
import { ScheduleTriggerButton } from "./schedule-trigger-button.tsx";

function trigger(view: ReturnType<typeof mountForm>) {
  const button = view.container.querySelector("button");
  if (!button) throw new Error("missing trigger button");
  return button;
}

describe("ScheduleTriggerButton", () => {
  it("queues a new run and navigates to its session", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "session/1", created: true }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<ScheduleTriggerButton id="schedule/1" />);
    press(trigger(view));
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledWith("/api/v1/schedules/schedule%2F1/trigger", {
      method: "POST",
    });
    expect(router.push).toHaveBeenCalledWith("/sessions/session%2F1?toast=Schedule+run+queued.");
    view.unmount();
  });

  it("routes duplicate runs to the active session or schedule", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ created: false, activeSessionId: "active/1" }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ created: false, id: "fallback/1" }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ created: false }), { status: 200 })),
    );
    const view = mountForm(<ScheduleTriggerButton id="schedule/1" />);
    press(trigger(view));
    await act(async () => Promise.resolve());
    expect(router.push).toHaveBeenLastCalledWith(
      "/sessions/active%2F1?toast=A+run+with+this+concurrency+ID+is+already+active%3B+showing+it+instead.",
    );
    press(trigger(view));
    await act(async () => Promise.resolve());
    expect(router.push).toHaveBeenLastCalledWith(
      "/sessions/fallback%2F1?toast=A+run+with+this+concurrency+ID+is+already+active%3B+showing+it+instead.",
    );
    press(trigger(view));
    await act(async () => Promise.resolve());
    expect(router.push).toHaveBeenLastCalledWith(
      "/schedules/schedule%2F1?toast=A+run+with+this+concurrency+ID+is+already+active%3B+showing+it+instead.",
    );
    view.unmount();
  });

  it("shows an error destination and a pending label", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))),
    );
    const view = mountForm(<ScheduleTriggerButton id="schedule/1" />);
    press(trigger(view));
    expect(trigger(view).disabled).toBe(true);
    expect(trigger(view).textContent).toBe("…");
    await act(async () => finish(new Response("failed", { status: 500 })));
    expect(router.push).toHaveBeenLastCalledWith(
      "/schedules/schedule%2F1?toast=Could+not+run+schedule.",
    );
    view.unmount();
  });
});
