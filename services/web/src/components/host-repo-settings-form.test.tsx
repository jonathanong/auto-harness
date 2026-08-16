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

/**
 * Inventory mutations now read fresh immediately before writing, so the stub must answer
 * the GET as well as the PUT.
 */
function stubInventoryFetch(current: unknown) {
  const fetch = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      init?.method === "PUT"
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(current), { status: 200 }),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function putBody(fetch: { mock: { calls: unknown[][] } }): unknown {
  const call = fetch.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PUT");
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body));
}

/**
 * Answers the read immediately and defers the write, which is the call under test. The
 * write only starts once the read resolves, so `finish` waits for it to register.
 */
function stubDeferredPut(current: unknown) {
  let settle: ((response: Response) => void) | undefined;
  const fetch = vi.fn((_url: string, init?: RequestInit) =>
    init?.method === "PUT"
      ? new Promise<Response>((resolve) => (settle = resolve))
      : Promise.resolve(new Response(JSON.stringify(current), { status: 200 })),
  );
  vi.stubGlobal("fetch", fetch);
  // The write starts only after the read resolves, so yield until it registers. The loop
  // condition is updated from the fetch stub, not from inside the loop body.
  const finish = async (response: Response) => {
    for (let i = 0; i < 20; i += 1) {
      if (settle) break;
      await Promise.resolve();
    }
    settle?.(response);
  };
  return { fetch, finish };
}

describe("HostRepoSettingsForm", () => {
  it("opens its settings, exposes labelled inputs, and cancels", () => {
    const view = mountForm(<HostRepoSettingsForm hostId="host" repo={repo} />);
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
    const view = mountForm(<HostRepoSettingsForm hostId="host" repo={repo} />);
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
    const fetch = stubInventoryFetch(inventory);
    const view = mountForm(<HostRepoSettingsForm hostId="host/one" repo={repo} />);
    press(field(view.container, "repo-settings-open-repo-1"));
    setValue(field(view.container, "repo-settings-path-repo-1"), " /new/repo ");
    setValue(field(view.container, "repo-settings-branch-repo-1"), " ");
    setValue(field(view.container, "repo-settings-setup-repo-1"), "setup");
    setValue(field(view.container, "repo-settings-hook-repo-1"), "hook");
    submit(field(view.container, "form-repo-settings-repo-1"));
    await act(async () => Promise.resolve());
    expect(putBody(fetch)).toMatchObject({
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
    const { finish } = stubDeferredPut(inventory);
    const view = mountForm(<HostRepoSettingsForm hostId="host" repo={repo} />);
    press(field(view.container, "repo-settings-open-repo-1"));
    const form = field<HTMLFormElement>(view.container, "form-repo-settings-repo-1");
    field(view.container, "repo-settings-branch-repo-1").remove();
    field(view.container, "repo-settings-setup-repo-1").remove();
    field(view.container, "repo-settings-hook-repo-1").remove();
    submit(form);
    expect(field<HTMLButtonElement>(view.container, "repo-settings-submit-repo-1").disabled).toBe(
      true,
    );
    await act(async () => await finish(new Response("cannot save", { status: 500 })));
    expect(field(view.container, "repo-settings-error-repo-1").textContent).toBe("cannot save");
    view.unmount();
  });
});
