// @vitest-environment happy-dom

import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, router, setValue, submit } from "./form-test-helpers.tsx";
import { HostAddRepoForm } from "./host-add-repo-form.tsx";

describe("HostAddRepoForm", () => {
  it("stays on the current host tab and shows a toast instead of navigating to the repository page", async () => {
    const mutate = vi.fn().mockResolvedValueOnce({ ok: true });
    const view = mountForm(
      <HostAddRepoForm
        hostId="host-1"
        catalog={[{ id: "repo-1", name: "Repo" }]}
        mutate={mutate}
      />,
      { pathname: "/hosts/host-1", searchParams: new URLSearchParams("tab=repositories") },
    );
    setValue(field(view.container, "add-repo-path"), "/src/repo");
    submit(field(view.container, "form-add-local-repo"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mutate).toHaveBeenCalledWith("host-1", expect.any(Function));
    expect(router.push).toHaveBeenCalledTimes(1);
    const [href] = router.push.mock.calls[0] as [string];
    expect(href).toContain("/hosts/host-1?");
    expect(href).toContain("tab=repositories");
    expect(href).toContain("toast=");
    view.unmount();
  });

  it("stays on the current path with no other query params", async () => {
    const mutate = vi.fn().mockResolvedValueOnce({ ok: true });
    const view = mountForm(
      <HostAddRepoForm
        hostId="host-1"
        catalog={[{ id: "repo-1", name: "Repo" }]}
        mutate={mutate}
      />,
      { pathname: "/hosts/host-1", searchParams: new URLSearchParams() },
    );
    setValue(field(view.container, "add-repo-path"), "/src/repo");
    submit(field(view.container, "form-add-local-repo"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const [href] = router.push.mock.calls[0] as [string];
    expect(href).toBe("/hosts/host-1?toast=Repository+attached+with+no+worktrees.");
    view.unmount();
  });
});
