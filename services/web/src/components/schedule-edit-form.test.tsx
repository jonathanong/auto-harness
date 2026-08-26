// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, json, mountForm, press, router, setValue, submit } from "./form-test-helpers.tsx";
import { ScheduleEditForm, type EditableSchedule } from "./schedule-edit-form.tsx";

const targets = [
  { kind: "provider" as const, id: "p1", label: "Claude" },
  { kind: "command" as const, id: "c1", label: "Review" },
];
const schedule: EditableSchedule = {
  id: "schedule/1",
  repositoryId: "repo-1",
  name: "Nightly",
  target: { providerId: "p1" },
  fallbacks: [{ commandId: "c1" }],
  targetDisplayNames: ["Claude", "Review"],
  cron: "0 1 * * *",
  enabled: true,
  timeout: 900,
  queueTtlSeconds: 3600,
  ref: "main",
  concurrencyId: "nightly",
  activeSessionId: null,
  prompt: "review the repo",
};

describe("ScheduleEditForm", () => {
  it("submits edited fields and refreshes after saving", async () => {
    const fetch = vi.fn().mockResolvedValue(json({}));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<ScheduleEditForm schedule={schedule} targets={targets} />);
    const form = field<HTMLFormElement>(view.container, "form-edit-schedule");
    expect(form.checkValidity()).toBe(true);
    setValue(field(view.container, "edit-schedule-name"), "Every night");
    setValue(field(view.container, "edit-schedule-concurrency-id"), "  stable  ");
    press(field(view.container, "edit-schedule-enabled"));
    submit(form);
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/schedules/schedule%2F1",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      repositoryId: "repo-1",
      name: "Every night",
      target: { providerId: "p1" },
      fallbacks: [{ commandId: "c1" }],
      enabled: false,
      concurrencyId: "stable",
      prompt: "review the repo",
    });
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("shows a saving state and renders API errors", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))),
    );
    const scheduleWithoutRef = { ...schedule };
    delete scheduleWithoutRef.ref;
    const view = mountForm(
      <ScheduleEditForm
        schedule={{ ...scheduleWithoutRef, enabled: false, concurrencyId: null }}
        targets={targets}
      />,
    );
    submit(field(view.container, "form-edit-schedule"));
    expect(field<HTMLButtonElement>(view.container, "edit-schedule-submit").disabled).toBe(true);
    expect(field<HTMLButtonElement>(view.container, "edit-schedule-submit").textContent).toBe(
      "Saving…",
    );
    await act(async () =>
      finish(
        new Response(JSON.stringify({ error: { message: "schedule is locked" } }), { status: 409 }),
      ),
    );
    expect(field(view.container, "edit-schedule-error").textContent).toBe("schedule is locked");
    view.container.querySelectorAll("input").forEach((input) => input.remove());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({})));
    submit(field(view.container, "form-edit-schedule"));
    await act(async () => Promise.resolve());
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });
});
