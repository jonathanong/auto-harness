// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, router, setValue, submit } from "./form-test-helpers.tsx";
import { AttachLocalRepoForm } from "./attach-local-repo-form.tsx";

const repos = [{ id: "repo-1", name: "Catalog", defaultBranch: "trunk" }];

describe("AttachLocalRepoForm", () => {
  it("explains when hosts or catalog repositories are unavailable", () => {
    const noHosts = mountForm(<AttachLocalRepoForm hostIds={[]} repos={repos} />);
    expect(noHosts.container.textContent).toContain("No hosts yet");
    noHosts.unmount();
    const noRepos = mountForm(<AttachLocalRepoForm hostIds={["host"]} repos={[]} />);
    expect(noRepos.container.textContent).toContain("No catalog repositories yet");
    noRepos.unmount();
  });

  it("validates an absent host, repository, or path", () => {
    const view = mountForm(<AttachLocalRepoForm hostIds={["host"]} repos={repos} />);
    const form = field<HTMLFormElement>(view.container, "form-attach-local-repo");
    field(view.container, "attach-repo-agent-id").remove();
    submit(form);
    expect(field(view.container, "attach-repo-error").textContent).toContain("are required");
    view.unmount();
    const noRepo = mountForm(<AttachLocalRepoForm hostIds={["host"]} repos={repos} />);
    field(noRepo.container, "attach-repo-catalog-id").remove();
    submit(field(noRepo.container, "form-attach-local-repo"));
    expect(field(noRepo.container, "attach-repo-error").textContent).toContain("are required");
    noRepo.unmount();
    const noPath = mountForm(<AttachLocalRepoForm hostIds={["host"]} repos={repos} />);
    field(noPath.container, "attach-repo-path").remove();
    submit(field(noPath.container, "form-attach-local-repo"));
    expect(field(noPath.container, "attach-repo-error").textContent).toContain("are required");
    noPath.unmount();
  });

  it("attaches the chosen catalog repository and navigates with a toast", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <AttachLocalRepoForm hostIds={["host/one", "host/two"]} repos={repos} />,
    );
    setValue(field(view.container, "attach-repo-agent-id"), "host/two");
    setValue(field(view.container, "attach-repo-path"), " /repo ");
    setValue(field(view.container, "attach-repo-branch"), " ");
    submit(field(view.container, "form-attach-local-repo"));
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      repositories: [{ id: "repo-1", path: "/repo", defaultBranch: "main" }],
    });
    expect(router.push).toHaveBeenCalledWith(
      "/repositories/repo-1?toast=Attached+Catalog+on+host+host%2Ftwo+with+no+worktrees.",
    );
    view.unmount();
  });

  it("uses the repository id fallback after a successful attach", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<AttachLocalRepoForm hostIds={["host"]} repos={repos} />);
    const repoSelect = field<HTMLSelectElement>(view.container, "attach-repo-catalog-id");
    const unknown = document.createElement("option");
    unknown.value = "unknown";
    unknown.textContent = "Unknown";
    repoSelect.add(unknown);
    setValue(repoSelect, "unknown");
    setValue(field(view.container, "attach-repo-path"), "/repo");
    submit(field(view.container, "form-attach-local-repo"));
    await act(async () => Promise.resolve());
    expect(router.push).toHaveBeenCalledWith(
      "/repositories/unknown?toast=Attached+unknown+on+host+host+with+no+worktrees.",
    );
    view.unmount();
  });

  it("shows a pending attach failure", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (finish = resolve)));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<AttachLocalRepoForm hostIds={["host"]} repos={repos} />);
    setValue(field(view.container, "attach-repo-path"), "/repo");
    submit(field(view.container, "form-attach-local-repo"));
    await act(async () => Promise.resolve());
    expect(field<HTMLButtonElement>(view.container, "attach-repo-submit").disabled).toBe(true);
    await act(async () => finish(new Response("cannot attach", { status: 500 })));
    expect(field(view.container, "attach-repo-error").textContent).toBe("cannot attach");
    view.unmount();
  });

  it("uses main when the branch field is absent", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<AttachLocalRepoForm hostIds={["host"]} repos={repos} />);
    field(view.container, "attach-repo-branch").remove();
    setValue(field(view.container, "attach-repo-path"), "/repo");
    submit(field(view.container, "form-attach-local-repo"));
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      repositories: [{ defaultBranch: "main" }],
    });
    view.unmount();
  });
});
