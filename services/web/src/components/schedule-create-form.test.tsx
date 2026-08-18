// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, json, mountForm, router, setValue, submit } from "./form-test-helpers.tsx";
import { ScheduleCreateForm } from "./schedule-create-form.tsx";

const targets = [{ kind: "command" as const, id: "cmd/1", label: "Review" }];
const repositories = [{ id: "repo-1", name: "Repo" }];
const schedule = {
  id: "schedule/1",
  repositoryId: "repo-1",
  name: "Nightly",
  target: { commandId: "cmd/1" },
  fallbacks: [],
  cron: "0 1 * * *",
  timeout: 900,
  queueTtlSeconds: 3600,
  nextRunAt: "2026-08-11T01:00:00.000Z",
  ref: "main",
};

function fill(view: ReturnType<typeof mountForm>) {
  setValue(field(view.container, "schedule-repository-id"), "repo-1");
  setValue(field(view.container, "schedule-name"), "Nightly");
  setValue(field(view.container, "schedule-cron"), "0 1 * * *");
}

describe("ScheduleCreateForm", () => {
  it("validates and creates a schedule, including routing fields", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ id: "schedule/1" }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<ScheduleCreateForm targets={targets} repositories={repositories} />);
    const form = field<HTMLFormElement>(view.container, "form-create-schedule");
    expect(form.checkValidity()).toBe(false);
    fill(view);
    setValue(field(view.container, "schedule-concurrency-id"), "  nightly  ");
    expect(form.checkValidity()).toBe(true);
    submit(form);
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/schedules",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      repositoryId: "repo-1",
      name: "Nightly",
      target: { commandId: "cmd/1" },
      fallbacks: [],
      concurrencyId: "nightly",
    });
    expect(router.push).toHaveBeenCalledWith("/schedules/schedule%2F1?toast=Schedule+created.");
    view.unmount();
  });

  it("resets and refreshes when creation returns no id", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(json({})));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<ScheduleCreateForm targets={targets} repositories={repositories} />);
    fill(view);
    submit(field(view.container, "form-create-schedule"));
    await act(async () => Promise.resolve());
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(field<HTMLInputElement>(view.container, "schedule-name").value).toBe("");
    view.container.querySelectorAll("input").forEach((input) => input.remove());
    submit(field(view.container, "form-create-schedule"));
    await act(async () => Promise.resolve());
    expect(router.refresh).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("reports errors while pending and disables an empty target list", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))),
    );
    const view = mountForm(<ScheduleCreateForm targets={targets} repositories={repositories} />);
    fill(view);
    submit(field(view.container, "form-create-schedule"));
    expect(field<HTMLButtonElement>(view.container, "schedule-submit").disabled).toBe(true);
    expect(field<HTMLButtonElement>(view.container, "schedule-submit").textContent).toBe("Saving…");
    await act(async () => finish(new Response("cron rejected", { status: 400 })));
    expect(field(view.container, "schedule-error").textContent).toBe("cron rejected");
    view.unmount();

    const empty = mountForm(<ScheduleCreateForm targets={[]} repositories={repositories} />);
    expect(field<HTMLButtonElement>(empty.container, "schedule-submit").disabled).toBe(true);
    empty.unmount();
  });

  it("renders edit-mode defaults and uses its edit selector", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ id: "schedule/1" })));
    const view = mountForm(
      <ScheduleCreateForm targets={targets} repositories={repositories} schedule={schedule} />,
    );
    expect(field(view.container, "form-edit-schedule-schedule/1")).toBeTruthy();
    expect(field<HTMLInputElement>(view.container, "schedule-name").value).toBe("Nightly");
    expect(
      field<HTMLButtonElement>(view.container, "schedule-edit-submit-schedule/1").textContent,
    ).toBe("Save schedule");
    submit(field(view.container, "form-edit-schedule-schedule/1"));
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/schedules/schedule%2F1",
      expect.objectContaining({ method: "PATCH" }),
    );
    view.unmount();
  });
});
