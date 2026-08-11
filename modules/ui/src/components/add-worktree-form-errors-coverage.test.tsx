// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AddWorktreeForm } from "./add-worktree-form.tsx";
import {
  input,
  inventory,
  mount,
  repo,
  reset,
  response,
  submit,
} from "./action-form-test-helpers.ts";

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

describe("AddWorktreeForm errors", () => {
  it("validates missing name and path", async () => {
    const view = mount(
      <AddWorktreeForm
        hostId="host-1"
        inventory={{ ...inventory, repositories: [repo] }}
        repo={repo}
        repoName="Repo"
      />,
    );
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

  it("reports rejected writes and thrown errors", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const rejected = mount(
      <AddWorktreeForm
        hostId="host-1"
        inventory={{ ...inventory, repositories: [repo] }}
        repo={repo}
        repoName="Repo"
      />,
    );
    const rejectedForm = open(rejected);
    fill(rejected);
    fetch.mockResolvedValueOnce(response(false, "denied"));
    await submit(rejectedForm);
    expect(rejected.container.textContent).toContain("denied");

    const unknown = mount(
      <AddWorktreeForm hostId="host-1" inventory={inventory} repo={repo} repoName="Repo" />,
    );
    const unknownForm = open(unknown);
    fill(unknown);
    await submit(unknownForm);
    expect(unknown.container.textContent).toContain("Unknown repository: repo-1");

    const offline = mount(
      <AddWorktreeForm
        hostId="host-1"
        inventory={{ ...inventory, repositories: [repo] }}
        repo={repo}
        repoName="Repo"
      />,
    );
    const offlineForm = open(offline);
    fill(offline);
    fetch.mockRejectedValueOnce("offline");
    await submit(offlineForm);
    expect(offline.container.textContent).toContain("offline");
  });
});
