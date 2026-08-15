// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, json, mountForm, router, setValue, submit } from "./form-test-helpers.tsx";
import { RepoCreateForm } from "./repo-create-form.tsx";

describe("RepoCreateForm", () => {
  it("keeps required accessible catalog fields and submits a created repository", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ id: "repo-1" }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<RepoCreateForm />);
    const form = field<HTMLFormElement>(view.container, "form-repo-catalog");
    const name = field<HTMLInputElement>(view.container, "repo-catalog-name");
    expect(form.checkValidity()).toBe(false);
    expect(name.labels?.[0]?.textContent).toBe("name");
    expect(field<HTMLButtonElement>(view.container, "repo-catalog-submit").textContent).toBe(
      "Create repository",
    );
    setValue(name, "catalog-repo");
    setValue(field(view.container, "repo-catalog-url"), "git@example.test:catalog-repo.git");
    setValue(field(view.container, "repo-catalog-setup"), "pnpm install\npnpm build");
    submit(form);
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/repositories",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      name: "catalog-repo",
      url: "git@example.test:catalog-repo.git",
      defaultBranch: "main",
      setupScript: "pnpm install\npnpm build",
    });
    expect(router.push).toHaveBeenCalledWith("/repositories/repo-1?toast=Repository+created.");
    view.unmount();
  });

  it("shows a request error and disables its submit control while saving", async () => {
    let finish!: (res: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))),
    );
    const view = mountForm(<RepoCreateForm />);
    const form = field<HTMLFormElement>(view.container, "form-repo-catalog");
    setValue(field(view.container, "repo-catalog-name"), "catalog-repo");
    setValue(field(view.container, "repo-catalog-url"), "/repo");
    submit(form);
    expect(field<HTMLButtonElement>(view.container, "repo-catalog-submit").disabled).toBe(true);
    expect(field<HTMLButtonElement>(view.container, "repo-catalog-submit").textContent).toBe(
      "Saving…",
    );
    await act(async () => finish(new Response("already registered", { status: 409 })));
    expect(field(view.container, "repo-catalog-error").textContent).toBe("already registered");
    view.unmount();
  });

  it("uses empty catalog values and main when fields are absent", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ id: "repo-empty" }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<RepoCreateForm />);
    const form = field<HTMLFormElement>(view.container, "form-repo-catalog");
    form.querySelectorAll("input, textarea").forEach((input) => input.remove());
    submit(form);
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      name: "",
      url: "",
      defaultBranch: "main",
      setupScript: "",
    });
    view.unmount();
  });
});
