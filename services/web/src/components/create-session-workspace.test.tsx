// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  field,
  json,
  mountForm,
  press,
  setValue,
  submit,
} from "../../test-helpers/form-test-helpers.tsx";
import { CreateSessionForm } from "./create-session-form.tsx";

const targets = [{ kind: "provider" as const, id: "p/1", label: "Claude" }];
const repositories = [{ id: "repo-1", name: "repo-one" }];
const pools = [
  {
    id: "pool-1",
    name: "Browser tests",
    setupProfiles: [{ id: "install", name: "Install dependencies" }],
    defaultSetupProfileId: "install",
    destroyWorkspaceAfter: false,
  },
];

describe("CreateSessionForm workspace policy", () => {
  it("allows exec-config authors to select a cleanup override without sending a raw script", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ id: "workspace-session" }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <CreateSessionForm
        targets={targets}
        repositories={repositories}
        workspacePools={pools}
        canWriteExecConfig
      />,
    );
    press(field(view.container, "create-session-mode-workspace"));
    setValue(field(view.container, "create-session-workspace-pool"), "pool-1");
    setValue(field(view.container, "create-session-workspace-profile"), "install");
    setValue(field(view.container, "create-session-workspace-cleanup"), "true");
    setValue(field(view.container, "create-session-prompt"), "Run browser tests");
    submit(field(view.container, "form-create-session"));
    await act(async () => Promise.resolve());

    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      repositoryId: null,
      type: "workspace",
      workspacePoolId: "pool-1",
      setupProfileId: "install",
      destroyWorkspaceAfter: true,
      requiredLabels: [],
    });
    expect(body).not.toHaveProperty("setupScript");
    expect(view.container.querySelector('[data-pw="create-session-ref"]')).toBeNull();
    view.unmount();
  });

  it("keeps an ordinary workspace clone on its pool cleanup policy", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ id: "workspace-clone" }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <CreateSessionForm
        targets={targets}
        repositories={repositories}
        workspacePools={pools}
        initialValues={{
          repositoryId: null,
          workspacePoolId: "pool-1",
          destroyWorkspaceAfter: true,
          prompt: "Replay browser tests",
          target: { providerId: "p/1" },
          fallbacks: [],
          queueTtlSeconds: 60,
          timeout: 30,
          priority: 0,
          requiredLabels: [],
        }}
      />,
    );
    expect(view.container.querySelector('select[name="destroyWorkspaceAfter"]')).toBeNull();
    expect(field(view.container, "create-session-workspace-cleanup").textContent).toContain(
      "require fleet:exec-config",
    );
    submit(field(view.container, "form-create-session"));
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).not.toHaveProperty(
      "destroyWorkspaceAfter",
    );
    view.unmount();
  });
});
