// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, json, mountForm, submit } from "../../test-helpers/form-test-helpers.tsx";
import { ScheduleCreateForm } from "./schedule-create-form.tsx";

describe("ScheduleCreateForm workspace coverage", () => {
  it("keeps a stale workspace schedule structured when its pool is no longer cataloged", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ id: "schedule-1" }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <ScheduleCreateForm
        targets={[{ kind: "command", id: "command-1", label: "Review" }]}
        repositories={[]}
        workspacePools={[]}
        schedule={{
          id: "schedule-1",
          repositoryId: "",
          workspacePoolId: "retired-pool",
          setupProfileId: null,
          destroyWorkspaceAfter: null,
          name: "Retired workspace schedule",
          target: { commandId: "command-1" },
          fallbacks: [],
          cron: "0 1 * * *",
          timeout: 900,
          queueTtlSeconds: 3600,
        }}
      />,
    );

    expect(field<HTMLSelectElement>(view.container, "schedule-workspace-pool").value).toBe(
      "retired-pool",
    );
    expect(field(view.container, "schedule-workspace-cleanup").textContent).toContain(
      "Use pool policy (retain)",
    );
    submit(field(view.container, "form-edit-schedule-schedule-1"));
    await act(async () => Promise.resolve());

    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ repositoryId: null, workspacePoolId: "retired-pool" });
    expect(body).not.toHaveProperty("setupProfileId");
    expect(body).not.toHaveProperty("destroyWorkspaceAfter");
    expect(body).not.toHaveProperty("ref");
    view.unmount();
  });

  it("preserves a stale configured profile without accepting raw setup input", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ id: "schedule-2" }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <ScheduleCreateForm
        targets={[{ kind: "command", id: "command-1", label: "Review" }]}
        repositories={[]}
        workspacePools={[]}
        schedule={{
          id: "schedule-2",
          repositoryId: "",
          workspacePoolId: "retired-pool",
          setupProfileId: "retired-profile",
          name: "Retired profile schedule",
          target: { commandId: "command-1" },
          fallbacks: [],
          cron: "0 2 * * *",
          timeout: 900,
          queueTtlSeconds: 3600,
        }}
      />,
    );
    field(view.container, "schedule-workspace-profile").removeAttribute("name");
    submit(field(view.container, "form-edit-schedule-schedule-2"));
    await act(async () => Promise.resolve());

    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body).not.toHaveProperty("setupProfileId");
    expect(body).not.toHaveProperty("setupScript");
    view.unmount();
  });
});
