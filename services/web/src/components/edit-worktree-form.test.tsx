// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, press, router, setValue, submit } from "./form-test-helpers.tsx";
import { EditWorktreeForm } from "./edit-worktree-form.tsx";

const worktree = { id: "worktree-1", name: "feature", path: "/repo/feature", labels: ["fast"] };
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

function form(worktreeValue = worktree) {
  return (
    <EditWorktreeForm
      hostId="host/one"
      inventory={inventory}
      repositoryId="repo-1"
      worktree={worktreeValue}
    />
  );
}

describe("EditWorktreeForm", () => {
  it("opens with worktree values and cancels", () => {
    const view = mountForm(form());
    press(field(view.container, "worktree-edit-open"));
    expect(field<HTMLInputElement>(view.container, "worktree-edit-path").value).toBe(
      "/repo/feature",
    );
    expect(field<HTMLInputElement>(view.container, "worktree-edit-labels").value).toBe("fast");
    press(
      [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel",
      )!,
    );
    expect(view.container.querySelector('[data-pw="form-edit-worktree"]')).toBeNull();
    view.unmount();
  });

  it("requires an absolute path", () => {
    const view = mountForm(form());
    press(field(view.container, "worktree-edit-open"));
    field(view.container, "worktree-edit-path").remove();
    submit(field(view.container, "form-edit-worktree"));
    expect(field(view.container, "worktree-edit-error").textContent).toBe(
      "absolute path is required",
    );
    view.unmount();
  });

  it("saves trimmed paths and labels, preserving worktree settings", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(form());
    press(field(view.container, "worktree-edit-open"));
    setValue(field(view.container, "worktree-edit-path"), " /new/feature ");
    setValue(field(view.container, "worktree-edit-labels"), " fast, ci, , fast ");
    submit(field(view.container, "form-edit-worktree"));
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/hosts/host%2Fone/inventory",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      repositories: [
        {
          worktrees: [
            {
              id: "worktree-1",
              name: "feature",
              path: "/new/feature",
              labels: ["fast", "ci", "fast"],
            },
          ],
        },
      ],
    });
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(view.container.querySelector('[data-pw="form-edit-worktree"]')).toBeNull();
    view.unmount();
  });

  it("uses missing-label fallbacks and displays a pending request failure", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (finish = resolve)));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(form({ ...worktree, labels: undefined } as typeof worktree));
    press(field(view.container, "worktree-edit-open"));
    field(view.container, "worktree-edit-labels").remove();
    submit(field(view.container, "form-edit-worktree"));
    expect(field<HTMLButtonElement>(view.container, "worktree-edit-submit").disabled).toBe(true);
    await act(async () => finish(new Response("cannot save", { status: 500 })));
    expect(field(view.container, "worktree-edit-error").textContent).toBe("cannot save");
    view.unmount();
  });
});
