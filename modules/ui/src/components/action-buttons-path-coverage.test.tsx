// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { input, mount, reset, response, router } from "./action-form-test-helpers.ts";
import { DrainButton } from "./drain-button.tsx";
import { PathInput } from "./path-input.tsx";
import { RemoveRepoButton } from "./remove-repo-button.tsx";
import { RemoveWorktreeButton } from "./remove-worktree-button.tsx";

async function confirm(pw: string) {
  act(() => (document.body.querySelector(`[data-pw="${pw}"]`) as HTMLButtonElement).click());
  await act(async () => {
    (document.body.querySelector(`[data-pw="${pw}-confirm-submit"]`) as HTMLButtonElement).click();
    await Promise.resolve();
  });
}

afterEach(() => {
  reset();
  vi.useRealTimers();
});

describe("shared path and destructive action controls", () => {
  it("fetches optional path suggestions and keeps plain path inputs local", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValueOnce(response(true, { items: ["/src/a", "/src/b"] }));
    const changed = vi.fn();
    const plain = mount(<PathInput value="/value" onChange={changed} />);
    expect(plain.container.querySelector("datalist")).toBeNull();
    input(plain.container.querySelector("input") as HTMLInputElement, "/changed");
    expect(changed).toHaveBeenCalledOnce();
    plain.unmount();

    const view = mount(
      <PathInput id="repo-path" defaultValue="/src" browseEndpoint="/browse" request={request} />,
    );
    await act(async () => void (await vi.advanceTimersByTimeAsync(150)));
    expect(request).toHaveBeenCalledWith("/browse?path=%2Fsrc", expect.anything());
    expect([...view.container.querySelectorAll("option")].map((option) => option.value)).toEqual([
      "/src/a",
      "/src/b",
    ]);
    input(view.container.querySelector("input") as HTMLInputElement, "/bad");
    request.mockResolvedValueOnce(response(false));
    await act(async () => void (await vi.advanceTimersByTimeAsync(150)));
    expect(view.container.querySelectorAll("option")).toHaveLength(0);
    input(view.container.querySelector("input") as HTMLInputElement, "/empty");
    request.mockResolvedValueOnce(response(true));
    await act(async () => void (await vi.advanceTimersByTimeAsync(150)));
    input(view.container.querySelector("input") as HTMLInputElement, "/offline");
    request.mockRejectedValueOnce(new Error("offline"));
    await act(async () => void (await vi.advanceTimersByTimeAsync(150)));
    view.unmount();
    mount(<PathInput browseEndpoint="/browse" />).unmount();
  });

  it("drains hosts with default and customized pending controls", async () => {
    let release!: (value: ReturnType<typeof response>) => void;
    const request = vi.fn(
      () => new Promise<ReturnType<typeof response>>((done) => (release = done)),
    );
    const standard = mount(<DrainButton hostId="host-1" />);
    expect(standard.container.textContent).toContain("Drain");
    standard.unmount();
    const view = mount(
      <DrainButton
        hostId="host-1"
        label="Pause"
        pendingLabel="Pausing"
        size="sm"
        tip="Pause new work"
        pw="host-drain"
        request={request}
      />,
    );
    await act(async () => {
      (view.container.querySelector('[data-pw="host-drain"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain("Pausing");
    expect(view.container.querySelector("button")?.disabled).toBe(true);
    release(response(true));
    await act(async () => void (await Promise.resolve()));
    expect(request).toHaveBeenCalledWith(
      "/api/v1/hosts/drain",
      expect.objectContaining({ method: "POST" }),
    );
    expect(view.container.querySelector("button")?.disabled).toBe(false);
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("requires confirmation and refreshes or redirects after repository removal", async () => {
    const readInventory = vi.fn().mockResolvedValue({
      repositories: [],
      providerAccounts: [],
      commandProfiles: {},
    });
    const writeInventory = vi.fn();
    mount(<RemoveRepoButton hostId="host-1" repositoryId="default" />).unmount();

    let view = mount(
      <RemoveRepoButton
        hostId="host-1"
        repositoryId="repo-1"
        readInventory={readInventory}
        writeInventory={writeInventory}
      />,
    );
    writeInventory.mockResolvedValueOnce({ ok: false, error: "failed" });
    await confirm("repo-remove-repo-1");
    expect(router.refresh).not.toHaveBeenCalled();
    view.unmount();

    view = mount(
      <RemoveRepoButton
        hostId="host-1"
        repositoryId="repo-1"
        readInventory={readInventory}
        writeInventory={writeInventory}
      />,
    );
    writeInventory.mockResolvedValueOnce({ ok: true });
    await confirm("repo-remove-repo-1");
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();

    mount(
      <RemoveRepoButton
        hostId="host-1"
        repositoryId="repo-1"
        redirectTo="/repositories"
        readInventory={readInventory}
        writeInventory={writeInventory}
      />,
    );
    writeInventory.mockResolvedValueOnce({ ok: true });
    await confirm("repo-remove-repo-1");
    expect(router.push).toHaveBeenCalledWith("/repositories");
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it("requires confirmation and refreshes or redirects after worktree removal", async () => {
    const current = {
      repositories: [{ id: "repo-1", path: "/src/repo", defaultBranch: "main", worktrees: [] }],
      providerAccounts: [],
      commandProfiles: {},
    };
    const readInventory = vi.fn().mockResolvedValue(current);
    const writeInventory = vi.fn();
    mount(
      <RemoveWorktreeButton hostId="host-1" repositoryId="repo-1" worktreeId="default" />,
    ).unmount();

    let view = mount(
      <RemoveWorktreeButton
        hostId="host-1"
        repositoryId="repo-1"
        worktreeId="worktree-1"
        readInventory={readInventory}
        writeInventory={writeInventory}
      />,
    );
    writeInventory.mockResolvedValueOnce({ ok: false, error: "failed" });
    await confirm("worktree-remove-worktree-1");
    expect(router.refresh).not.toHaveBeenCalled();
    view.unmount();

    view = mount(
      <RemoveWorktreeButton
        hostId="host-1"
        repositoryId="repo-1"
        worktreeId="worktree-1"
        readInventory={readInventory}
        writeInventory={writeInventory}
      />,
    );
    writeInventory.mockResolvedValueOnce({ ok: true });
    await confirm("worktree-remove-worktree-1");
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();

    mount(
      <RemoveWorktreeButton
        hostId="host-1"
        repositoryId="repo-1"
        worktreeId="worktree-1"
        redirectTo="/worktrees"
        readInventory={readInventory}
        writeInventory={writeInventory}
      />,
    );
    writeInventory.mockResolvedValueOnce({ ok: true });
    await confirm("worktree-remove-worktree-1");
    expect(router.push).toHaveBeenCalledWith("/worktrees");
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });
});
