// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it } from "vitest";
import type { HostRepository } from "@auto-harness/shared";

import { field, mountForm, setValue } from "./form-test-helpers.tsx";
import { attachmentsForRepo } from "./add-worktree-attachments.ts";
import { AddWorktreeForRepo } from "./add-worktree-for-repo.tsx";

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}
if (!HTMLElement.prototype.setPointerCapture) {
  HTMLElement.prototype.setPointerCapture = () => {};
}
if (!HTMLElement.prototype.releasePointerCapture) {
  HTMLElement.prototype.releasePointerCapture = () => {};
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

const repoA: HostRepository = {
  id: "repo-1",
  path: "/src/repo",
  defaultBranch: "main",
  worktrees: [],
};
const repoB: HostRepository = { ...repoA, path: "/other/repo" };

describe("attachmentsForRepo", () => {
  it("collects host attachments that include the repository", () => {
    expect(
      attachmentsForRepo(
        [
          { hostId: "host-a", repositories: [repoA] },
          { hostId: "host-b", repositories: [] },
          { hostId: "host-c" },
          { hostId: "host-d", repositories: [repoB] },
        ],
        "repo-1",
      ),
    ).toEqual([
      { hostId: "host-a", repo: repoA },
      { hostId: "host-d", repo: repoB },
    ]);
  });
});

describe("AddWorktreeForRepo", () => {
  it("explains when the repository is not attached to any host", () => {
    const view = mountForm(
      <AddWorktreeForRepo repositoryId="repo-1" repositoryName="Repo" attachments={[]} />,
    );
    expect(field(view.container, "add-worktree-need-host-repo-1").textContent).toContain(
      "Hosts page",
    );
    expect(view.container.querySelector('[data-pw="add-worktree-open-repo-1"]')).toBeNull();
    view.unmount();
  });

  it("opens the add-worktree dialog for a single host", () => {
    const view = mountForm(
      <AddWorktreeForRepo
        repositoryId="repo-1"
        repositoryName="Repo"
        attachments={[{ hostId: "host-a", repo: repoA }]}
      />,
    );
    expect(view.container.querySelector('[data-pw="add-worktree-host-repo-1"]')).toBeNull();
    act(() => field<HTMLButtonElement>(view.container, "add-worktree-open-repo-1").click());
    expect(document.querySelector('[data-pw="add-worktree-dialog-repo-1"]')).not.toBeNull();
    view.unmount();
  });

  it("switches the add-worktree host when several attachments exist", () => {
    const view = mountForm(
      <AddWorktreeForRepo
        repositoryId="repo-1"
        repositoryName="Repo"
        attachments={[
          { hostId: "host-a", repo: repoA },
          { hostId: "host-b", repo: repoB },
        ]}
      />,
    );
    const picker = field<HTMLSelectElement>(view.container, "add-worktree-host-repo-1");
    expect(picker.value).toBe("host-a");
    setValue(picker, "host-b");
    expect(field<HTMLSelectElement>(view.container, "add-worktree-host-repo-1").value).toBe(
      "host-b",
    );
    view.unmount();
  });
});
