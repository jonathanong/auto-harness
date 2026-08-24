/* eslint-disable max-lines -- repository settings and concurrency cases share fixtures. */
// @vitest-environment happy-dom

import React, { act } from "react";
import type { HostInventory } from "@auto-harness/shared";
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
import { HostRepoSettingsForm } from "./host-repo-settings-form.tsx";

const repo = {
  id: "repo-1",
  path: "/old/repo",
  defaultBranch: "trunk",
  worktrees: [{ id: "worktree", name: "worktree", path: "/old/worktree", labels: [] }],
};
const inventory = { repositories: [repo], providerAccounts: [], commandProfiles: {} };

type MutationResult = Awaited<
  ReturnType<NonNullable<React.ComponentProps<typeof HostRepoSettingsForm>["mutate"]>>
>;
type Mutation = NonNullable<React.ComponentProps<typeof HostRepoSettingsForm>["mutate"]>;

function inMemoryInventory<T extends object>(
  initial: T,
): {
  mutate: Mutation;
  current: () => T;
} {
  let current = structuredClone(initial);
  const mutate = vi.fn(
    async (_hostId: string, update: (current: HostInventory) => HostInventory) => {
      current = update(current as HostInventory) as T;
      return { ok: true } as const;
    },
  ) as Mutation;
  return { mutate, current: () => current };
}

describe("HostRepoSettingsForm", () => {
  it("opens its settings, exposes labelled inputs, and cancels", () => {
    const view = mountForm(<HostRepoSettingsForm hostId="host" repo={repo} />);
    press(field(view.container, "repo-settings-open-repo-1"));
    expect(
      field<HTMLInputElement>(document, "repo-settings-path-repo-1").labels?.[0]?.textContent,
    ).toBe("Absolute Path");
    expect(field<HTMLInputElement>(document, "repo-settings-path-repo-1").value).toBe("/old/repo");
    pressCancel();
    expect(document.querySelector('[data-pw="form-repo-settings-repo-1"]')).toBeNull();
    view.unmount();
  });

  it("requires an absolute path before saving", () => {
    const view = mountForm(<HostRepoSettingsForm hostId="host" repo={repo} />);
    press(field(view.container, "repo-settings-open-repo-1"));
    const form = field<HTMLFormElement>(document, "form-repo-settings-repo-1");
    field(document, "repo-settings-path-repo-1").remove();
    submit(form);
    expect(field(document, "repo-settings-error-repo-1").textContent).toBe(
      "absolute path is required",
    );
    view.unmount();
  });

  it("rejects a relative terminal hook before writing inventory", () => {
    const persistence = inMemoryInventory(inventory);
    const view = mountForm(
      <HostRepoSettingsForm
        hostId="host"
        repo={repo}
        canWriteExecConfig
        mutate={persistence.mutate}
      />,
    );
    press(field(view.container, "repo-settings-open-repo-1"));
    setValue(field(document, "repo-settings-hook-repo-1"), "hooks/done.sh");
    submit(field(document, "form-repo-settings-repo-1"));
    expect(field(document, "repo-settings-error-repo-1").textContent).toBe(
      "repository.repo-1.terminalHookScript must be an absolute path",
    );
    expect(persistence.mutate).not.toHaveBeenCalled();
    view.unmount();
  });

  it("allows an unchanged legacy relative hook while saving ordinary settings", async () => {
    const legacyRepo = { ...repo, terminalHookScript: "./hook.sh" };
    const persistence = inMemoryInventory({
      ...inventory,
      repositories: [legacyRepo],
    });
    const view = mountForm(
      <HostRepoSettingsForm
        hostId="host"
        repo={legacyRepo}
        canWriteExecConfig
        mutate={persistence.mutate}
      />,
    );
    press(field(view.container, "repo-settings-open-repo-1"));
    setValue(field(document, "repo-settings-path-repo-1"), "/new/repo");
    submit(field(document, "form-repo-settings-repo-1"));
    await act(async () => Promise.resolve());
    expect(document.querySelector('[data-pw="repo-settings-error-repo-1"]')).toBeNull();
    expect(persistence.current()).toMatchObject({
      repositories: [{ id: "repo-1", path: "/new/repo", terminalHookScript: "./hook.sh" }],
    });
    view.unmount();
  });

  it("saves trimmed settings with a main fallback and keeps worktrees", async () => {
    const persistence = inMemoryInventory(inventory);
    const view = mountForm(
      <HostRepoSettingsForm
        hostId="host/one"
        repo={repo}
        canWriteExecConfig
        mutate={persistence.mutate}
      />,
    );
    press(field(view.container, "repo-settings-open-repo-1"));
    setValue(field(document, "repo-settings-path-repo-1"), " /new/repo ");
    setValue(field(document, "repo-settings-branch-repo-1"), " ");
    setValue(field(document, "repo-settings-setup-repo-1"), "setup");
    setValue(field(document, "repo-settings-hook-repo-1"), "/opt/harness/hook.sh");
    setValue(field(document, "repo-settings-required-environment-repo-1"), "Z_TOKEN, A_TOKEN");
    submit(field(document, "form-repo-settings-repo-1"));
    await act(async () => Promise.resolve());
    expect(persistence.current()).toMatchObject({
      repositories: [
        {
          id: "repo-1",
          path: "/new/repo",
          defaultBranch: "main",
          requiredEnvironment: ["A_TOKEN", "Z_TOKEN"],
          setupScript: "setup",
          terminalHookScript: "/opt/harness/hook.sh",
          worktrees: [{ id: "worktree" }],
        },
      ],
    });
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-pw="form-repo-settings-repo-1"]')).toBeNull();
    view.unmount();
  });

  it("does not overwrite concurrent exec fields during an ordinary repository save", async () => {
    const concurrent = {
      ...inventory,
      repositories: [
        {
          ...repo,
          setupScript: "concurrent setup",
          terminalHookScript: "/concurrent/hook.sh",
        },
      ],
    };
    const persistence = inMemoryInventory(concurrent);
    const view = mountForm(
      <HostRepoSettingsForm
        hostId="host"
        repo={{
          ...repo,
          setupScript: "page setup",
          terminalHookScript: "/page/hook.sh",
        }}
        canWriteExecConfig
        mutate={persistence.mutate}
      />,
    );
    press(field(view.container, "repo-settings-open-repo-1"));
    setValue(field(document, "repo-settings-path-repo-1"), "/new/repo");
    submit(field(document, "form-repo-settings-repo-1"));
    await act(async () => Promise.resolve());

    expect(persistence.current()).toMatchObject({
      repositories: [
        expect.objectContaining({
          setupScript: "concurrent setup",
          terminalHookScript: "/concurrent/hook.sh",
        }),
      ],
    });
    view.unmount();
  });

  it("surfaces inventory save failures and hides scripts without the capability", async () => {
    const failure: Mutation = vi.fn(async () => ({ ok: false, error: "denied" })) as Mutation;
    const view = mountForm(<HostRepoSettingsForm hostId="host" repo={repo} mutate={failure} />);
    press(field(view.container, "repo-settings-open-repo-1"));
    submit(field(document, "form-repo-settings-repo-1"));
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());
    expect(field(document, "repo-settings-error-repo-1").textContent).toContain("denied");
    view.unmount();

    const hidden = mountForm(
      <HostRepoSettingsForm hostId="host" repo={repo} canWriteExecConfig={false} />,
    );
    press(field(hidden.container, "repo-settings-open-repo-1"));
    expect(document.querySelector('[data-pw="repo-settings-setup-repo-1"]')).toBeNull();
    hidden.unmount();
  });

  it("rejects invalid required environment names before saving", () => {
    const persistence = inMemoryInventory(inventory);
    const view = mountForm(
      <HostRepoSettingsForm hostId="host" repo={repo} mutate={persistence.mutate} />,
    );
    press(field(view.container, "repo-settings-open-repo-1"));
    setValue(field(document, "repo-settings-required-environment-repo-1"), "HARNESS_API_KEY");
    submit(field(document, "form-repo-settings-repo-1"));
    expect(field(document, "repo-settings-error-repo-1").textContent).toBe(
      "repository.repo-1.requiredEnvironment contains an invalid environment variable name",
    );
    expect(persistence.mutate).not.toHaveBeenCalled();
    expect(document.querySelector('[data-pw="form-repo-settings-repo-1"]')).not.toBeNull();
    view.unmount();
  });

  it("shows an aggregate requirement limit error from the fresh inventory", async () => {
    const persistence = inMemoryInventory({
      ...inventory,
      requiredEnvironment: Array.from({ length: 256 }, (_, index) => `HOST_${index}`),
    });
    const view = mountForm(
      <HostRepoSettingsForm hostId="host" repo={repo} mutate={persistence.mutate} />,
    );
    press(field(view.container, "repo-settings-open-repo-1"));
    setValue(field(document, "repo-settings-required-environment-repo-1"), "REPOSITORY");
    submit(field(document, "form-repo-settings-repo-1"));
    await act(async () => Promise.resolve());
    expect(field(document, "repo-settings-error-repo-1").textContent).toContain(
      "must contain at most 256 distinct names",
    );
    expect(persistence.mutate).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-pw="form-repo-settings-repo-1"]')).not.toBeNull();
    view.unmount();
  });

  it("uses absent field fallbacks and displays a pending save failure", async () => {
    let finish: ((result: MutationResult) => void) | undefined;
    const pendingMutation: Mutation = vi.fn(
      () => new Promise<MutationResult>((resolve) => (finish = resolve)),
    ) as Mutation;
    const view = mountForm(
      <HostRepoSettingsForm
        hostId="host"
        repo={repo}
        canWriteExecConfig
        mutate={pendingMutation}
      />,
    );
    press(field(view.container, "repo-settings-open-repo-1"));
    const form = field<HTMLFormElement>(document, "form-repo-settings-repo-1");
    field(document, "repo-settings-branch-repo-1").remove();
    field(document, "repo-settings-setup-repo-1").remove();
    field(document, "repo-settings-hook-repo-1").remove();
    submit(form);
    expect(field<HTMLButtonElement>(document, "repo-settings-submit-repo-1").disabled).toBe(true);
    await act(async () => finish?.({ ok: false, error: "cannot save" }));
    expect(field(document, "repo-settings-error-repo-1").textContent).toBe("cannot save");
    view.unmount();
  });
});
