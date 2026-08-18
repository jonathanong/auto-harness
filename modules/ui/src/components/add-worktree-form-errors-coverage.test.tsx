// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostInventory } from "@auto-harness/shared";

import { AddWorktreeForm } from "./add-worktree-form.tsx";
import { input, mount, repo, reset, submit } from "./action-form-test-helpers.ts";

afterEach(reset);

function open(view: ReturnType<typeof mount>) {
  act(() => (view.container.querySelector("button") as HTMLButtonElement).click());
  return view.container.querySelector("form") as HTMLFormElement;
}

function fill(view: ReturnType<typeof mount>) {
  input(
    view.container.querySelector('[data-pw="add-worktree-name-repo-1"]') as HTMLInputElement,
    "runner",
  );
  input(
    view.container.querySelector('[data-pw="add-worktree-path-repo-1"]') as HTMLInputElement,
    "/src/runner",
  );
}

const withRepo: HostInventory = { repositories: [repo], providerAccounts: [] };
const withoutRepo: HostInventory = { repositories: [], providerAccounts: [] };

describe("AddWorktreeForm errors", () => {
  it("validates missing name and path", async () => {
    const view = mount(<AddWorktreeForm hostId="host-1" repo={repo} repoName="Repo" />);
    const form = open(view);
    input(
      view.container.querySelector('[data-pw="add-worktree-path-repo-1"]') as HTMLInputElement,
      "/src/runner",
    );
    await submit(form);
    fill(view);
    input(
      view.container.querySelector('[data-pw="add-worktree-path-repo-1"]') as HTMLInputElement,
      "",
    );
    await submit(form);
    expect(view.container.textContent).toContain("worktree name and absolute path are required");
  });

  it("reports a rejected write, an unknown repository, and a thrown error", async () => {
    // Invoke the transform mutate() receives, rather than only asserting the component reacts
    // to a stubbed ok/error result — this actually exercises addHostWorktree.
    const mutate = vi.fn((_hostId: string, transform: (current: HostInventory) => HostInventory) =>
      Promise.resolve(transform(withRepo)).then(() => ({ ok: false as const, error: "denied" })),
    );
    const rejected = mount(
      <AddWorktreeForm hostId="host-1" repo={repo} repoName="Repo" mutate={mutate} />,
    );
    const rejectedForm = open(rejected);
    fill(rejected);
    await submit(rejectedForm);
    expect(rejected.container.textContent).toContain("denied");

    const unknownRepoMutate = vi.fn(
      (_hostId: string, transform: (current: HostInventory) => HostInventory) =>
        Promise.resolve().then(() => {
          transform(withoutRepo);
          return { ok: true as const };
        }),
    );
    const unknown = mount(
      <AddWorktreeForm hostId="host-1" repo={repo} repoName="Repo" mutate={unknownRepoMutate} />,
    );
    const unknownForm = open(unknown);
    fill(unknown);
    await submit(unknownForm);
    expect(unknown.container.textContent).toContain("Unknown repository: repo-1");

    const offline = mount(
      <AddWorktreeForm
        hostId="host-1"
        repo={repo}
        repoName="Repo"
        mutate={vi.fn().mockRejectedValueOnce("offline")}
      />,
    );
    const offlineForm = open(offline);
    fill(offline);
    await submit(offlineForm);
    expect(offline.container.textContent).toContain("offline");
  });
});
