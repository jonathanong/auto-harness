/* eslint-disable max-lines -- edit form regressions cover ordinary and exec-config saves. */
// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  field,
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

type MutationResult = Awaited<
  ReturnType<NonNullable<React.ComponentProps<typeof EditWorktreeForm>["mutate"]>>
>;
type Mutation = NonNullable<React.ComponentProps<typeof EditWorktreeForm>["mutate"]>;

function form(worktreeValue = worktree, mutate?: Mutation) {
  return (
    <EditWorktreeForm
      hostId="host/one"
      repositoryId="repo-1"
      worktree={worktreeValue}
      canWriteExecConfig
      {...(mutate ? { mutate } : {})}
    />
  );
}

/** A component-level persistence fake: no global HTTP transport is involved in these tests. */
function inMemoryInventory(initial: typeof inventory): {
  mutate: Mutation;
  current: () => typeof inventory;
} {
  let current = structuredClone(initial);
  const mutate = vi.fn(async (_hostId, update) => {
    current = update(current) as typeof inventory;
    return { ok: true } as const;
  }) as Mutation;
  return { mutate, current: () => current };
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
    const persistence = inMemoryInventory(inventory);
    const view = mountForm(form(worktree, persistence.mutate));
    press(field(view.container, "worktree-edit-open"));
    setValue(field(document, "worktree-edit-path"), " /new/feature ");
    setValue(field(document, "worktree-edit-labels"), " fast, ci, , fast ");
    setValue(field(document, "worktree-edit-setup-script"), "pnpm install");
    submit(field(document, "form-edit-worktree"));
    await act(async () => Promise.resolve());
    expect(persistence.current()).toMatchObject({
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
    expect(persistence.mutate).toHaveBeenCalledWith("host/one", expect.any(Function));
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-pw="form-edit-worktree"]')).toBeNull();
    view.unmount();
  });

  it("clears a blank setup override so repository setup is inherited", async () => {
    const persistence = inMemoryInventory(inventory);
    const view = mountForm(form(worktree, persistence.mutate));
    press(field(view.container, "worktree-edit-open"));
    setValue(field(document, "worktree-edit-setup-script"), "   ");
    submit(field(document, "form-edit-worktree"));
    await act(async () => Promise.resolve());
    expect(persistence.current()).toMatchObject({
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
    const persistence = inMemoryInventory(current);
    const view = mountForm(form(worktree, persistence.mutate));
    press(field(view.container, "worktree-edit-open"));
    setValue(field(document, "worktree-edit-path"), "/new/feature");
    submit(field(document, "form-edit-worktree"));
    await act(async () => Promise.resolve());
    expect(persistence.current()).toMatchObject({
      repositories: [{ worktrees: [{ setupScript: "concurrent setup" }] }],
    });
    view.unmount();
  });

  it("does not carry setup-script dirtiness across a cancelled edit after a fresh script arrives", async () => {
    const fresh = {
      ...worktree,
      setupScript: "fresh concurrent setup",
    };
    const persistence = inMemoryInventory({
      ...inventory,
      repositories: [{ ...inventory.repositories[0], worktrees: [fresh] }],
    });
    const view = mountForm(form(worktree, persistence.mutate));
    press(field(view.container, "worktree-edit-open"));
    setValue(field(document, "worktree-edit-setup-script"), "discarded setup");
    pressCancel();
    view.unmount();
    const refreshed = mountForm(form(fresh, persistence.mutate));
    press(field(refreshed.container, "worktree-edit-open"));
    setValue(field(document, "worktree-edit-path"), "/new/feature");
    submit(field(document, "form-edit-worktree"));
    await act(async () => Promise.resolve());
    expect(persistence.current()).toMatchObject({
      repositories: [{ worktrees: [{ setupScript: "fresh concurrent setup" }] }],
    });
    refreshed.unmount();
  });

  it("surfaces inventory save failures and hides setup without the capability", async () => {
    const failure: Mutation = vi.fn(async () => ({ ok: false, error: "denied" })) as Mutation;
    const view = mountForm(form(worktree, failure));
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
    let finish: ((result: MutationResult) => void) | undefined;
    const pendingMutation: Mutation = vi.fn(
      () => new Promise<MutationResult>((resolve) => (finish = resolve)),
    ) as Mutation;
    // Deliberately simulates malformed data (missing labels) to exercise the component's
    // `worktree.labels ?? []` fallback — the real HostWorktree type always has labels.
    const view = mountForm(
      form({ ...worktree, labels: undefined } as unknown as typeof worktree, pendingMutation),
    );
    press(field(view.container, "worktree-edit-open"));
    field<HTMLInputElement>(document, "worktree-edit-labels").remove();
    submit(field(document, "form-edit-worktree"));
    expect(field<HTMLButtonElement>(document, "worktree-edit-submit").disabled).toBe(true);
    await act(async () => finish?.({ ok: false, error: "cannot save" }));
    expect(field(document, "worktree-edit-error").textContent).toBe("cannot save");
    view.unmount();
  });
});
