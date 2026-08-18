// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AddWorktreeForm } from "./add-worktree-form.tsx";
import { input, mount, repo, reset, router, submit } from "./action-form-test-helpers.ts";

afterEach(reset);

describe("AddWorktreeForm success flow", () => {
  it("opens, cancels, suggests paths, saves labels, and exposes pending state", async () => {
    let release!: (value: { ok: true }) => void;
    const mutate = vi.fn(() => new Promise<{ ok: true }>((done) => (release = done)));
    const view = mount(
      <AddWorktreeForm hostId="host-1" repo={repo} repoName="Repo" mutate={mutate} />,
    );
    act(() =>
      (
        view.container.querySelector('[data-pw="add-worktree-open-repo-1"]') as HTMLButtonElement
      ).click(),
    );
    act(() =>
      (
        [...view.container.querySelectorAll("button")].find(
          (button) => button.textContent === "Cancel",
        ) as HTMLButtonElement
      ).click(),
    );
    act(() =>
      (
        view.container.querySelector('[data-pw="add-worktree-open-repo-1"]') as HTMLButtonElement
      ).click(),
    );
    const form = view.container.querySelector("form") as HTMLFormElement;
    const name = view.container.querySelector(
      '[data-pw="add-worktree-name-repo-1"]',
    ) as HTMLInputElement;
    const path = view.container.querySelector(
      '[data-pw="add-worktree-path-repo-1"]',
    ) as HTMLInputElement;
    input(name, " ");
    input(name, "runner-0");
    input(name, "runner-1");
    expect(path.value).toBe("/src/repo/.worktrees/runner-1");
    input(path, "/src/repo/custom");
    input(name, "runner-2");
    expect(path.value).toBe("/src/repo/custom");
    input(path, "/src/repo/.worktrees/runner-2");
    input(name, "runner-3");
    input(
      view.container.querySelector('[data-pw="add-worktree-labels-repo-1"]') as HTMLInputElement,
      "echo, , build",
    );
    await submit(form);
    expect(
      view.container.querySelector('[data-pw="add-worktree-submit-repo-1"]')?.textContent,
    ).toBe("Saving…");
    release({ ok: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(view.container.querySelector("form")).toBeNull();
  });
});
