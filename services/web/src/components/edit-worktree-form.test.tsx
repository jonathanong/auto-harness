/* eslint-disable max-lines -- edit form regressions cover ordinary and exec-config saves. */
// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it } from "vitest";

import {
  createApiFake,
  field,
  json,
  mountForm,
  press,
  pressCancel,
  router,
  setValue,
  submit,
} from "./form-test-helpers.tsx";
import { EditWorktreeForm } from "./edit-worktree-form.tsx";

const worktree = {
  id: "worktree-1",
  name: "feature",
  path: "/repo/feature",
  labels: ["fast"],
  setupScript: "old setup",
};
const inventory = {
  repositories: [
    {
      id: "repo-1",
      path: "/repo",
      defaultBranch: "main",
      worktrees: [worktree],
    },
  ],
  providerAccounts: [],
  commandProfiles: {},
};

function form(worktreeValue = worktree) {
  return (
    <EditWorktreeForm
      hostId="host/one"
      repositoryId="repo-1"
      worktree={worktreeValue}
      canWriteExecConfig
    />
  );
}

describe("EditWorktreeForm", () => {
  it("opens with worktree values and cancels", () => {
    const view = mountForm(form());
    press(field(view.container, "worktree-edit-open"));
    expect(field<HTMLInputElement>(document, "worktree-edit-path").value).toBe("/repo/feature");
    expect(field<HTMLInputElement>(document, "worktree-edit-labels").value).toBe("fast");
    expect(field<HTMLTextAreaElement>(document, "worktree-edit-setup-script").value).toBe(
      "old setup",
    );
    pressCancel();
    expect(document.querySelector('[data-pw="form-edit-worktree"]')).toBeNull();
    view.unmount();
  });

  it("requires an absolute path", () => {
    const view = mountForm(form());
    press(field(view.container, "worktree-edit-open"));
    field<HTMLInputElement>(document, "worktree-edit-path").remove();
    submit(field(document, "form-edit-worktree"));
    expect(field(document, "worktree-edit-error").textContent).toBe("absolute path is required");
    view.unmount();
  });

  it("saves trimmed paths and labels, preserving worktree settings", async () => {
    const api = createApiFake(
      json({ ...inventory, version: 4 }),
      new Response(null, { status: 204 }),
    );
    const view = mountForm(form());
    press(field(view.container, "worktree-edit-open"));
    setValue(field(document, "worktree-edit-path"), " /new/feature ");
    setValue(field(document, "worktree-edit-labels"), " fast, ci, , fast ");
    setValue(field(document, "worktree-edit-setup-script"), "pnpm install");
    submit(field(document, "form-edit-worktree"));
    await act(async () => Promise.resolve());
    expect(api.requests).toHaveLength(2);
    expect(JSON.parse(String(api.requests[1]?.[1]?.body))).toMatchObject({
      repositories: [
        {
          worktrees: [
            {
              id: "worktree-1",
              name: "feature",
              path: "/new/feature",
              labels: ["fast", "ci", "fast"],
              setupScript: "pnpm install",
            },
          ],
        },
      ],
    });
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-pw="form-edit-worktree"]')).toBeNull();
    view.unmount();
  });

  it("clears a blank setup override so repository setup is inherited", async () => {
    const api = createApiFake(
      json({ ...inventory, version: 4 }),
      new Response(null, { status: 204 }),
    );
    const view = mountForm(form());
    press(field(view.container, "worktree-edit-open"));
    setValue(field(document, "worktree-edit-setup-script"), "   ");
    submit(field(document, "form-edit-worktree"));
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(api.requests[1]?.[1]?.body))).toMatchObject({
      repositories: [{ worktrees: [{ id: "worktree-1", setupScript: "" }] }],
    });
    view.unmount();
  });

  it("preserves a concurrently changed setup script when only ordinary fields are edited", async () => {
    const current = {
      ...inventory,
      repositories: [
        {
          ...inventory.repositories[0],
          worktrees: [{ ...worktree, setupScript: "concurrent setup" }],
        },
      ],
    };
    const api = createApiFake(
      json({ ...current, version: 5 }),
      new Response(null, { status: 204 }),
    );
    const view = mountForm(form());
    press(field(view.container, "worktree-edit-open"));
    setValue(field(document, "worktree-edit-path"), "/new/feature");
    submit(field(document, "form-edit-worktree"));
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(api.requests[1]?.[1]?.body))).toMatchObject({
      repositories: [{ worktrees: [{ setupScript: "concurrent setup" }] }],
    });
    view.unmount();
  });

  it("does not carry setup-script dirtiness across a cancelled edit after a fresh script arrives", async () => {
    const fresh = {
      ...worktree,
      setupScript: "fresh concurrent setup",
    };
    const current = {
      ...inventory,
      repositories: [{ ...inventory.repositories[0], worktrees: [fresh] }],
    };
    const view = mountForm(form());
    press(field(view.container, "worktree-edit-open"));
    setValue(field(document, "worktree-edit-setup-script"), "discarded setup");
    pressCancel();
    view.unmount();
    const api = createApiFake(
      json({ ...current, version: 6 }),
      new Response(null, { status: 204 }),
    );
    const refreshed = mountForm(form(fresh));
    press(field(refreshed.container, "worktree-edit-open"));
    setValue(field(document, "worktree-edit-path"), "/new/feature");
    submit(field(document, "form-edit-worktree"));
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(api.requests[1]?.[1]?.body))).toMatchObject({
      repositories: [{ worktrees: [{ setupScript: "fresh concurrent setup" }] }],
    });
    refreshed.unmount();
  });

  it("surfaces inventory save failures and hides setup without the capability", async () => {
    createApiFake(json({ ...inventory, version: 4 }), json({ error: { message: "denied" } }, 403));
    const view = mountForm(form());
    press(field(view.container, "worktree-edit-open"));
    submit(field(document, "form-edit-worktree"));
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());
    expect(field(document, "worktree-edit-error").textContent).toContain("denied");
    view.unmount();

    const hidden = mountForm(
      <EditWorktreeForm
        hostId="host/one"
        repositoryId="repo-1"
        worktree={worktree}
        canWriteExecConfig={false}
      />,
    );
    press(field(hidden.container, "worktree-edit-open"));
    expect(document.querySelector('[data-pw="worktree-edit-setup-script"]')).toBeNull();
    hidden.unmount();
  });

  it("uses missing-label fallbacks and displays a pending request failure", async () => {
    let finish: ((result: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => (finish = resolve));
    createApiFake(json({ ...inventory, version: 4 }), pending);
    // Deliberately simulates malformed data (missing labels) to exercise the component's
    // `worktree.labels ?? []` fallback — the real HostWorktree type always has labels.
    const view = mountForm(form({ ...worktree, labels: undefined } as unknown as typeof worktree));
    press(field(view.container, "worktree-edit-open"));
    field<HTMLInputElement>(document, "worktree-edit-labels").remove();
    submit(field(document, "form-edit-worktree"));
    expect(field<HTMLButtonElement>(document, "worktree-edit-submit").disabled).toBe(true);
    await act(async () => finish?.(json({ error: { message: "cannot save" } }, 500)));
    expect(field(document, "worktree-edit-error").textContent).toBe("cannot save");
    view.unmount();
  });
});
