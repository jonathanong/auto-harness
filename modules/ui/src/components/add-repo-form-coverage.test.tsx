// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AddRepoForm } from "./add-repo-form.tsx";
import { input, inventory, mount, reset, router, submit } from "./action-form-test-helpers.ts";

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
    let release!: (value: { ok: true }) => void;
    const writeInventory = vi.fn(() => new Promise<{ ok: true }>((done) => (release = done)));
    const view = mount(
      <AddRepoForm
        hostId="host-1"
        inventory={inventory}
        catalog={[{ id: "repo-1", name: "Repo" }]}
        browseEndpoint="/browse"
        writeInventory={writeInventory}
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
    release({ ok: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(writeInventory.mock.calls[0]?.[1].repositories[0]).toMatchObject({
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
        writeInventory={writeInventory}
      />,
    );
    input(
      missing.container.querySelector('[data-pw="add-repo-path"]') as HTMLInputElement,
      "/src/repo",
    );
    (
      missing.container.querySelector('[data-pw="add-repo-branch"]') as HTMLInputElement
    ).removeAttribute("name");
    writeInventory.mockResolvedValueOnce({ ok: true });
    await submit(missing.container.querySelector("form") as HTMLFormElement);
    missing.unmount();

    const failed = mount(
      <AddRepoForm
        hostId="host-1"
        inventory={inventory}
        catalog={[{ id: "repo-1", name: "Repo" }]}
        writeInventory={writeInventory}
      />,
    );
    input(
      failed.container.querySelector('[data-pw="add-repo-path"]') as HTMLInputElement,
      "/src/repo",
    );
    writeInventory.mockResolvedValueOnce({ ok: false, error: "unavailable" });
    await submit(failed.container.querySelector("form") as HTMLFormElement);
    expect(failed.container.querySelector('[data-pw="add-repo-error"]')?.textContent).toBe(
      "unavailable",
    );
  });
});
