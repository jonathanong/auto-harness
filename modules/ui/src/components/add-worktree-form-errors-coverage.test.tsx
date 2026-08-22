// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HostInventory, type mutateInventory } from "@auto-harness/shared";

import { AddWorktreeForm } from "./add-worktree-form.tsx";
import { input, mount, repo, reset, setValue, submit } from "./action-form-test-helpers.ts";

afterEach(reset);

function open(view: ReturnType<typeof mount>) {
  act(() => (view.container.querySelector("button") as HTMLButtonElement).click());
  return document.querySelector("form") as HTMLFormElement;
}

function fill() {
  input(
    document.querySelector('[data-pw="add-worktree-name-repo-1"]') as HTMLInputElement,
    "runner",
  );
  input(
    document.querySelector('[data-pw="add-worktree-path-repo-1"]') as HTMLInputElement,
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
      document.querySelector('[data-pw="add-worktree-path-repo-1"]') as HTMLInputElement,
      "/src/runner",
    );
    await submit(form);
    fill();
    input(document.querySelector('[data-pw="add-worktree-path-repo-1"]') as HTMLInputElement, "");
    await submit(form);
    expect(document.body.textContent).toContain("worktree name and absolute path are required");
  });

  it("omits a blank setup override so the worktree inherits repository setup", async () => {
    let transformed: HostInventory | undefined;
    const mutate: typeof mutateInventory = async (_hostId, transform) => {
      transformed = transform(withRepo);
      return { ok: false, error: "stop after transform" };
    };
    const view = mount(
      <AddWorktreeForm hostId="host-1" repo={repo} repoName="Repo" mutate={mutate} />,
    );
    const form = open(view);
    fill();
    setValue(
      document.querySelector('[data-pw="add-worktree-setup-script-repo-1"]') as HTMLTextAreaElement,
      "   ",
    );
    await submit(form);
    expect(transformed?.repositories[0]?.worktrees[0]).not.toHaveProperty("setupScript");
    view.unmount();
  });

  it("reports a rejected write, an unknown repository, and a thrown error", async () => {
    // Invoke the transform mutate() receives, rather than only asserting the component reacts
    // to a stubbed ok/error result — this actually exercises addHostWorktree.
    let transformed: HostInventory | undefined;
    const mutate = vi.fn(
      (_hostId: string, transform: (current: HostInventory) => HostInventory) => {
        transformed = transform(withRepo);
        return Promise.resolve({ ok: false as const, error: "denied" });
      },
    );
    const rejected = mount(
      <AddWorktreeForm hostId="host-1" repo={repo} repoName="Repo" mutate={mutate} />,
    );
    const rejectedForm = open(rejected);
    fill();
    setValue(
      document.querySelector('[data-pw="add-worktree-setup-script-repo-1"]') as HTMLTextAreaElement,
      "pnpm install",
    );
    await submit(rejectedForm);
    expect(transformed?.repositories[0]?.worktrees[0]?.setupScript).toBe("pnpm install");
    expect(document.body.textContent).toContain("denied");
    rejected.unmount();

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
    fill();
    await submit(unknownForm);
    expect(document.body.textContent).toContain("Unknown repository: repo-1");
    unknown.unmount();

    const offline = mount(
      <AddWorktreeForm
        hostId="host-1"
        repo={repo}
        repoName="Repo"
        mutate={vi.fn().mockRejectedValueOnce("offline")}
      />,
    );
    const offlineForm = open(offline);
    fill();
    await submit(offlineForm);
    expect(document.body.textContent).toContain("offline");
  });
});
