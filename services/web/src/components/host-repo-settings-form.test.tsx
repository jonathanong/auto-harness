// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, press, router, setValue, submit } from "./form-test-helpers.tsx";
import { HostRepoSettingsForm } from "./host-repo-settings-form.tsx";

const repo = {
  id: "repo-1",
  path: "/old/repo",
  defaultBranch: "trunk",
  worktrees: [{ id: "worktree", name: "worktree", path: "/old/worktree", labels: [] }],
};
const inventory = { repositories: [repo], providerAccounts: [], commandProfiles: {} };

describe("HostRepoSettingsForm", () => {
  it("opens its settings, exposes labelled inputs, and cancels", () => {
    const view = mountForm(
      <HostRepoSettingsForm hostId="host" inventory={inventory} repo={repo} />,
    );
    press(field(view.container, "repo-settings-open-repo-1"));
    expect(
      field<HTMLInputElement>(view.container, "repo-settings-path-repo-1").labels?.[0]?.textContent,
    ).toBe("absolute path");
    expect(field<HTMLInputElement>(view.container, "repo-settings-path-repo-1").value).toBe(
      "/old/repo",
    );
    press(
      [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel",
      )!,
    );
    expect(view.container.querySelector('[data-pw="form-repo-settings-repo-1"]')).toBeNull();
    view.unmount();
  });

  it("requires an absolute path before saving", () => {
    const view = mountForm(
      <HostRepoSettingsForm hostId="host" inventory={inventory} repo={repo} />,
    );
    press(field(view.container, "repo-settings-open-repo-1"));
    const form = field<HTMLFormElement>(view.container, "form-repo-settings-repo-1");
    field(view.container, "repo-settings-path-repo-1").remove();
    submit(form);
    expect(field(view.container, "repo-settings-error-repo-1").textContent).toBe(
      "absolute path is required",
    );
    view.unmount();
  });

  it("saves trimmed settings with a main fallback and keeps worktrees", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <HostRepoSettingsForm hostId="host/one" inventory={inventory} repo={repo} />,
    );
    press(field(view.container, "repo-settings-open-repo-1"));
    setValue(field(view.container, "repo-settings-path-repo-1"), " /new/repo ");
    setValue(field(view.container, "repo-settings-branch-repo-1"), " ");
    setValue(field(view.container, "repo-settings-setup-repo-1"), "setup");
    setValue(field(view.container, "repo-settings-hook-repo-1"), "hook");
    submit(field(view.container, "form-repo-settings-repo-1"));
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      repositories: [
        {
          id: "repo-1",
          path: "/new/repo",
          defaultBranch: "main",
          setupScript: "setup",
          terminalHookScript: "hook",
          worktrees: [{ id: "worktree" }],
        },
      ],
    });
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(view.container.querySelector('[data-pw="form-repo-settings-repo-1"]')).toBeNull();
    view.unmount();
  });

  it("uses absent field fallbacks and displays a pending save failure", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (finish = resolve)));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <HostRepoSettingsForm hostId="host" inventory={inventory} repo={repo} />,
    );
    press(field(view.container, "repo-settings-open-repo-1"));
    const form = field<HTMLFormElement>(view.container, "form-repo-settings-repo-1");
    field(view.container, "repo-settings-branch-repo-1").remove();
    field(view.container, "repo-settings-setup-repo-1").remove();
    field(view.container, "repo-settings-hook-repo-1").remove();
    submit(form);
    expect(field<HTMLButtonElement>(view.container, "repo-settings-submit-repo-1").disabled).toBe(
      true,
    );
    await act(async () => finish(new Response("cannot save", { status: 500 })));
    expect(field(view.container, "repo-settings-error-repo-1").textContent).toBe("cannot save");
    view.unmount();
  });
});
