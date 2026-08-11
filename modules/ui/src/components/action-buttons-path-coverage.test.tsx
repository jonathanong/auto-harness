// @vitest-environment happy-dom

import { createRoot } from "react-dom/client";
import { act } from "react";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DrainButton } from "./drain-button.tsx";
import { PathInput } from "./path-input.tsx";
import { RemoveRepoButton } from "./remove-repo-button.tsx";
import { RemoveWorktreeButton } from "./remove-worktree-button.tsx";
import { TooltipProvider } from "./tooltip.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const router = {
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
} satisfies AppRouterInstance;

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <AppRouterContext.Provider value={router}>
        <TooltipProvider>{node}</TooltipProvider>
      </AppRouterContext.Provider>,
    ),
  );
  return { container, unmount: () => act(() => root.unmount()) };
}

function response(ok: boolean, body: unknown = {}) {
  return { ok, json: async () => body, text: async () => String(body) };
}

function input(element: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function confirm(pw: string) {
  act(() => (document.body.querySelector(`[data-pw="${pw}"]`) as HTMLButtonElement).click());
  await act(async () => {
    (document.body.querySelector(`[data-pw="${pw}-confirm-submit"]`) as HTMLButtonElement).click();
    await Promise.resolve();
  });
}

afterEach(() => {
  document.body.replaceChildren();
  router.refresh.mockReset();
  router.push.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("shared path and destructive action controls", () => {
  it("fetches optional path suggestions and keeps plain path inputs local", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(response(true, { items: ["/src/a", "/src/b"] }));
    vi.stubGlobal("fetch", fetch);
    const changed = vi.fn();
    const plain = mount(<PathInput value="/value" onChange={changed} />);
    expect(plain.container.querySelector("datalist")).toBeNull();
    input(plain.container.querySelector("input") as HTMLInputElement, "/changed");
    expect(changed).toHaveBeenCalledOnce();
    plain.unmount();

    const view = mount(<PathInput id="repo-path" defaultValue="/src" browseEndpoint="/browse" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(fetch).toHaveBeenCalledWith("/browse?path=%2Fsrc", expect.anything());
    expect([...view.container.querySelectorAll("option")].map((option) => option.value)).toEqual([
      "/src/a",
      "/src/b",
    ]);
    input(view.container.querySelector("input") as HTMLInputElement, "/bad");
    fetch.mockResolvedValueOnce(response(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(view.container.querySelectorAll("option")).toHaveLength(0);
    input(view.container.querySelector("input") as HTMLInputElement, "/empty");
    fetch.mockResolvedValueOnce(response(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    input(view.container.querySelector("input") as HTMLInputElement, "/offline");
    fetch.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    view.unmount();
    mount(<PathInput browseEndpoint="/browse" />).unmount();
  });

  it("drains hosts with default and customized pending controls", async () => {
    let release!: () => void;
    const fetch = vi.fn(() => new Promise<void>((done) => (release = done)));
    vi.stubGlobal("fetch", fetch);
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
      />,
    );
    await act(async () => {
      (view.container.querySelector('[data-pw="host-drain"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain("Pausing");
    expect(view.container.querySelector("button")?.disabled).toBe(true);
    release();
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/hosts/drain",
      expect.objectContaining({ method: "POST" }),
    );
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("requires confirmation and refreshes or redirects after repository removal", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    mount(<RemoveRepoButton hostId="host-1" repositoryId="repo-1" />);
    fetch
      .mockResolvedValueOnce(
        response(true, { repositories: [], providerAccounts: [], commandProfiles: {} }),
      )
      .mockResolvedValueOnce(response(false));
    await confirm("repo-remove-repo-1");
    expect(router.refresh).not.toHaveBeenCalled();
    document.body.replaceChildren();
    mount(<RemoveRepoButton hostId="host-1" repositoryId="repo-1" />);
    fetch.mockResolvedValueOnce(response(false)).mockResolvedValueOnce(response(true));
    await confirm("repo-remove-repo-1");
    expect(router.refresh).toHaveBeenCalledOnce();
    document.body.replaceChildren();
    mount(<RemoveRepoButton hostId="host-1" repositoryId="repo-1" redirectTo="/repositories" />);
    fetch.mockResolvedValueOnce(response(false)).mockResolvedValueOnce(response(true));
    await confirm("repo-remove-repo-1");
    expect(router.push).toHaveBeenCalledWith("/repositories");
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it("requires confirmation and refreshes or redirects after worktree removal", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const current = {
      repositories: [{ id: "repo-1", path: "/src/repo", defaultBranch: "main", worktrees: [] }],
      providerAccounts: [],
      commandProfiles: {},
    };
    mount(<RemoveWorktreeButton hostId="host-1" repositoryId="repo-1" worktreeId="worktree-1" />);
    fetch.mockResolvedValueOnce(response(true, current)).mockResolvedValueOnce(response(false));
    await confirm("worktree-remove-worktree-1");
    expect(router.refresh).not.toHaveBeenCalled();
    document.body.replaceChildren();
    mount(<RemoveWorktreeButton hostId="host-1" repositoryId="repo-1" worktreeId="worktree-1" />);
    fetch.mockResolvedValueOnce(response(true, current)).mockResolvedValueOnce(response(true));
    await confirm("worktree-remove-worktree-1");
    expect(router.refresh).toHaveBeenCalledOnce();
    document.body.replaceChildren();
    mount(
      <RemoveWorktreeButton
        hostId="host-1"
        repositoryId="repo-1"
        worktreeId="worktree-1"
        redirectTo="/worktrees"
      />,
    );
    fetch.mockResolvedValueOnce(response(true, current)).mockResolvedValueOnce(response(true));
    await confirm("worktree-remove-worktree-1");
    expect(router.push).toHaveBeenCalledWith("/worktrees");
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });
});
