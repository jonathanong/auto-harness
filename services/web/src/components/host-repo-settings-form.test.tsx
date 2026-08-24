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

describe("HostRepoSettingsForm", () => {
  it("opens its settings, exposes labelled inputs, and cancels", () => {
    const view = mountForm(<HostRepoSettingsForm hostId="host" repo={repo} />);
    press(field(view.container, "repo-settings-open-repo-1"));
    expect(
      field<HTMLInputElement>(document, "repo-settings-path-repo-1").labels?.[0]?.textContent,
    ).toBe("Absolute Path");
    expect(field<HTMLInputElement>(document, "repo-settings-path-repo-1").value).toBe("/old/repo");
    pressCancel();
    expect(document.querySelector('[data-pw="form-repo-settings-repo-1"]')).toBeNull();
    view.unmount();
  });

  it("requires an absolute path before saving", () => {
    const view = mountForm(<HostRepoSettingsForm hostId="host" repo={repo} />);
    press(field(view.container, "repo-settings-open-repo-1"));
    const form = field<HTMLFormElement>(document, "form-repo-settings-repo-1");
    field(document, "repo-settings-path-repo-1").remove();
    submit(form);
    expect(field(document, "repo-settings-error-repo-1").textContent).toBe(
      "absolute path is required",
    );
    view.unmount();
  });

  it("rejects a relative terminal hook before writing inventory", () => {
    const fetch = stubInventoryFetch(inventory);
    const view = mountForm(<HostRepoSettingsForm hostId="host" repo={repo} canWriteExecConfig />);
    press(field(view.container, "repo-settings-open-repo-1"));
    setValue(field(document, "repo-settings-hook-repo-1"), "hooks/done.sh");
    submit(field(document, "form-repo-settings-repo-1"));
    expect(field(document, "repo-settings-error-repo-1").textContent).toBe(
      "repository.repo-1.terminalHookScript must be an absolute path",
    );
    expect(
      fetch.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === "PUT"),
    ).toBe(false);
    view.unmount();
  });

  it("saves trimmed settings with a main fallback and keeps worktrees", async () => {
    const fetch = stubInventoryFetch(inventory);
    const view = mountForm(
      <HostRepoSettingsForm hostId="host/one" repo={repo} canWriteExecConfig />,
    );
    press(field(view.container, "repo-settings-open-repo-1"));
    setValue(field(document, "repo-settings-path-repo-1"), " /new/repo ");
    setValue(field(document, "repo-settings-branch-repo-1"), " ");
    setValue(field(document, "repo-settings-setup-repo-1"), "setup");
    setValue(field(document, "repo-settings-hook-repo-1"), "/opt/harness/hook.sh");
    setValue(field(document, "repo-settings-required-environment-repo-1"), "Z_TOKEN, A_TOKEN");
    submit(field(document, "form-repo-settings-repo-1"));
    await act(async () => Promise.resolve());
    expect(putBody(fetch)).toMatchObject({
      repositories: [
        {
          id: "repo-1",
          path: "/new/repo",
          defaultBranch: "main",
          requiredEnvironment: ["A_TOKEN", "Z_TOKEN"],
          setupScript: "setup",
          terminalHookScript: "/opt/harness/hook.sh",
          worktrees: [{ id: "worktree" }],
        },
      ],
    });
    expect(fetch.mock.calls.some((call) => String(call[0]).includes("/exec-config"))).toBe(false);
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-pw="form-repo-settings-repo-1"]')).toBeNull();
    view.unmount();
  });

  it("surfaces inventory save failures and hides scripts without the capability", async () => {
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
    const view = mountForm(<HostRepoSettingsForm hostId="host" repo={repo} />);
    press(field(view.container, "repo-settings-open-repo-1"));
    submit(field(document, "form-repo-settings-repo-1"));
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());
    expect(field(document, "repo-settings-error-repo-1").textContent).toContain("denied");
    view.unmount();

    const hidden = mountForm(
      <HostRepoSettingsForm hostId="host" repo={repo} canWriteExecConfig={false} />,
    );
    press(field(hidden.container, "repo-settings-open-repo-1"));
    expect(document.querySelector('[data-pw="repo-settings-setup-repo-1"]')).toBeNull();
    hidden.unmount();
  });

  it("rejects invalid required environment names before saving", () => {
    const fetch = stubInventoryFetch(inventory);
    const view = mountForm(<HostRepoSettingsForm hostId="host" repo={repo} />);
    press(field(view.container, "repo-settings-open-repo-1"));
    setValue(field(document, "repo-settings-required-environment-repo-1"), "HARNESS_API_KEY");
    submit(field(document, "form-repo-settings-repo-1"));
    expect(field(document, "repo-settings-error-repo-1").textContent).toBe(
      "repository.repo-1.requiredEnvironment contains an invalid environment variable name",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(document.querySelector('[data-pw="form-repo-settings-repo-1"]')).not.toBeNull();
    view.unmount();
  });

  it("shows an aggregate requirement limit error from the fresh inventory", async () => {
    const fetch = stubInventoryFetch({
      ...inventory,
      requiredEnvironment: Array.from({ length: 256 }, (_, index) => `HOST_${index}`),
    });
    const view = mountForm(<HostRepoSettingsForm hostId="host" repo={repo} />);
    press(field(view.container, "repo-settings-open-repo-1"));
    setValue(field(document, "repo-settings-required-environment-repo-1"), "REPOSITORY");
    submit(field(document, "form-repo-settings-repo-1"));
    await act(async () => Promise.resolve());
    expect(field(document, "repo-settings-error-repo-1").textContent).toContain(
      "must contain at most 256 distinct names",
    );
    expect(
      fetch.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === "PUT"),
    ).toBe(false);
    expect(document.querySelector('[data-pw="form-repo-settings-repo-1"]')).not.toBeNull();
    view.unmount();
  });

  it("uses absent field fallbacks and displays a pending save failure", async () => {
    const { finish } = stubDeferredPut(inventory);
    const view = mountForm(<HostRepoSettingsForm hostId="host" repo={repo} canWriteExecConfig />);
    press(field(view.container, "repo-settings-open-repo-1"));
    const form = field<HTMLFormElement>(document, "form-repo-settings-repo-1");
    field(document, "repo-settings-branch-repo-1").remove();
    field(document, "repo-settings-setup-repo-1").remove();
    field(document, "repo-settings-hook-repo-1").remove();
    submit(form);
    expect(field<HTMLButtonElement>(document, "repo-settings-submit-repo-1").disabled).toBe(true);
    await act(async () => await finish(new Response("cannot save", { status: 500 })));
    expect(field(document, "repo-settings-error-repo-1").textContent).toBe("cannot save");
    view.unmount();
  });
});
