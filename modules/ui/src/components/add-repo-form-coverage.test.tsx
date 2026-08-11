// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AddRepoForm } from "./add-repo-form.tsx";
import {
  input,
  inventory,
  mount,
  reset,
  response,
  router,
  submit,
} from "./action-form-test-helpers.ts";

afterEach(reset);

describe("AddRepoForm", () => {
  it("shows catalog prerequisites and validates every missing field fallback", async () => {
    const empty = mount(<AddRepoForm hostId="host-1" inventory={inventory} catalog={[]} />);
    expect(empty.container.textContent).toContain("No unattached catalog repositories");
    empty.unmount();
    const view = mount(
      <AddRepoForm
        hostId="host-1"
        inventory={inventory}
        catalog={[{ id: "repo-1", name: "Repo" }]}
      />,
    );
    const form = view.container.querySelector("form") as HTMLFormElement;
    const select = view.container.querySelector("select") as HTMLSelectElement;
    const path = view.container.querySelector('[data-pw="add-repo-path"]') as HTMLInputElement;
    input(path, "/src/repo");
    act(() => {
      select.value = "";
    });
    await submit(form);
    act(() => {
      select.value = "repo-1";
    });
    input(path, "");
    await submit(form);
    input(path, "/src/repo");
    select.removeAttribute("name");
    await submit(form);
    path.removeAttribute("name");
    await submit(form);
    expect(view.container.textContent).toContain("repository and absolute path are required");
    view.unmount();
  });

  it("handles pending, success defaults, and write errors", async () => {
    let release!: (value: ReturnType<typeof response>) => void;
    const fetch = vi.fn(() => new Promise<ReturnType<typeof response>>((done) => (release = done)));
    vi.stubGlobal("fetch", fetch);
    const view = mount(
      <AddRepoForm
        hostId="host-1"
        inventory={inventory}
        catalog={[{ id: "repo-1", name: "Repo" }]}
        browseEndpoint="/browse"
      />,
    );
    input(
      view.container.querySelector('[data-pw="add-repo-path"]') as HTMLInputElement,
      "/src/repo",
    );
    input(view.container.querySelector('[data-pw="add-repo-branch"]') as HTMLInputElement, "");
    await submit(view.container.querySelector("form") as HTMLFormElement);
    expect(view.container.querySelector('[data-pw="add-repo-submit"]')?.textContent).toBe(
      "Attaching…",
    );
    release(response(true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).repositories[0]).toMatchObject({
      defaultBranch: "main",
      path: "/src/repo",
    });
    expect(router.push).toHaveBeenCalledWith(
      expect.stringContaining("Repository+attached+with+no+worktrees."),
    );
    view.unmount();

    const missing = mount(
      <AddRepoForm
        hostId="host-1"
        inventory={inventory}
        catalog={[{ id: "repo-1", name: "Repo" }]}
      />,
    );
    input(
      missing.container.querySelector('[data-pw="add-repo-path"]') as HTMLInputElement,
      "/src/repo",
    );
    (
      missing.container.querySelector('[data-pw="add-repo-branch"]') as HTMLInputElement
    ).removeAttribute("name");
    fetch.mockResolvedValueOnce(response(true));
    await submit(missing.container.querySelector("form") as HTMLFormElement);
    missing.unmount();

    const failed = mount(
      <AddRepoForm
        hostId="host-1"
        inventory={inventory}
        catalog={[{ id: "repo-1", name: "Repo" }]}
      />,
    );
    input(
      failed.container.querySelector('[data-pw="add-repo-path"]') as HTMLInputElement,
      "/src/repo",
    );
    fetch.mockResolvedValueOnce(response(false, "unavailable"));
    await submit(failed.container.querySelector("form") as HTMLFormElement);
    expect(failed.container.querySelector('[data-pw="add-repo-error"]')?.textContent).toBe(
      "unavailable",
    );
  });
});
