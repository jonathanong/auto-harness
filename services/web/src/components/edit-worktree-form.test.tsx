// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  field,
  mountForm,
  press,
  pressCancel,
  router,
  setValue,
  submit,
} from "./form-test-helpers.tsx";
import { EditWorktreeForm } from "./edit-worktree-form.tsx";

const worktree = {
  id: "worktree-1",
  name: "feature",
  path: "/repo/feature",
  labels: ["fast"],
  setupScript: "old setup",
};
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
      repositoryId="repo-1"
      worktree={worktreeValue}
      canWriteExecConfig
    />
  );
}

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

function putBody(fetch: { mock: { calls: unknown[][] } }, path = "/inventory"): unknown {
  const call = fetch.mock.calls.find(
    (c) => String(c[0]).includes(path) && (c[1] as RequestInit | undefined)?.method === "PUT",
  );
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

describe("EditWorktreeForm", () => {
  it("opens with worktree values and cancels", () => {
    const view = mountForm(form());
    press(field(view.container, "worktree-edit-open"));
    expect(field<HTMLInputElement>(document, "worktree-edit-path").value).toBe("/repo/feature");
    expect(field<HTMLInputElement>(document, "worktree-edit-labels").value).toBe("fast");
    expect(field<HTMLTextAreaElement>(document, "worktree-edit-setup-script").value).toBe(
      "old setup",
    );
    pressCancel();
    expect(document.querySelector('[data-pw="form-edit-worktree"]')).toBeNull();
    view.unmount();
  });

  it("requires an absolute path", () => {
    const view = mountForm(form());
    press(field(view.container, "worktree-edit-open"));
    field<HTMLInputElement>(document, "worktree-edit-path").remove();
    submit(field(document, "form-edit-worktree"));
    expect(field(document, "worktree-edit-error").textContent).toBe("absolute path is required");
    view.unmount();
  });

  it("saves trimmed paths and labels, preserving worktree settings", async () => {
    const fetch = stubInventoryFetch(inventory);
    const view = mountForm(form());
    press(field(view.container, "worktree-edit-open"));
    setValue(field(document, "worktree-edit-path"), " /new/feature ");
    setValue(field(document, "worktree-edit-labels"), " fast, ci, , fast ");
    setValue(field(document, "worktree-edit-setup-script"), "pnpm install");
    submit(field(document, "form-edit-worktree"));
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/hosts/host%2Fone/inventory",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(putBody(fetch)).toMatchObject({
      repositories: [
        {
          worktrees: [
            {
              id: "worktree-1",
              name: "feature",
              path: "/new/feature",
              labels: ["fast", "ci", "fast"],
              setupScript: "pnpm install",
            },
          ],
        },
      ],
    });
    expect(fetch.mock.calls.some((call) => String(call[0]).includes("/exec-config"))).toBe(false);
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-pw="form-edit-worktree"]')).toBeNull();
    view.unmount();
  });

  it("clears a blank setup override so repository setup is inherited", async () => {
    const fetch = stubInventoryFetch(inventory);
    const view = mountForm(form());
    press(field(view.container, "worktree-edit-open"));
    setValue(field(document, "worktree-edit-setup-script"), "   ");
    submit(field(document, "form-edit-worktree"));
    await act(async () => Promise.resolve());
    expect(putBody(fetch)).toMatchObject({
      repositories: [{ worktrees: [{ id: "worktree-1", setupScript: "" }] }],
    });
    expect(fetch.mock.calls.some((call) => String(call[0]).includes("/exec-config"))).toBe(false);
    view.unmount();
  });

  it("surfaces inventory save failures and hides setup without the capability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve(
          init?.method === "PUT"
            ? new Response("denied", { status: 403 })
            : new Response(JSON.stringify(inventory), { status: 200 }),
        ),
      ),
    );
    const view = mountForm(form());
    press(field(view.container, "worktree-edit-open"));
    submit(field(document, "form-edit-worktree"));
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());
    expect(field(document, "worktree-edit-error").textContent).toContain("denied");
    view.unmount();

    const hidden = mountForm(
      <EditWorktreeForm
        hostId="host/one"
        repositoryId="repo-1"
        worktree={worktree}
        canWriteExecConfig={false}
      />,
    );
    press(field(hidden.container, "worktree-edit-open"));
    expect(document.querySelector('[data-pw="worktree-edit-setup-script"]')).toBeNull();
    hidden.unmount();
  });

  it("uses missing-label fallbacks and displays a pending request failure", async () => {
    const { finish } = stubDeferredPut(inventory);
    // Deliberately simulates malformed data (missing labels) to exercise the component's
    // `worktree.labels ?? []` fallback — the real HostWorktree type always has labels.
    const view = mountForm(form({ ...worktree, labels: undefined } as unknown as typeof worktree));
    press(field(view.container, "worktree-edit-open"));
    field<HTMLInputElement>(document, "worktree-edit-labels").remove();
    submit(field(document, "form-edit-worktree"));
    expect(field<HTMLButtonElement>(document, "worktree-edit-submit").disabled).toBe(true);
    await act(async () => await finish(new Response("cannot save", { status: 500 })));
    expect(field(document, "worktree-edit-error").textContent).toBe("cannot save");
    view.unmount();
  });
});
