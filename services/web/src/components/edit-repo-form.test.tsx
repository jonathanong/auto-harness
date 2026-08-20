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
import { EditRepoForm } from "./edit-repo-form.tsx";

const repository = {
  id: "repo/one",
  url: "git@example.test:one.git",
  defaultBranch: "trunk",
  setupScript: "install",
  terminalHookScript: "hook",
};

describe("EditRepoForm", () => {
  it("opens with catalog values, exposes documented selectors, and cancels", () => {
    const view = mountForm(<EditRepoForm repository={repository} />);
    expect(field<HTMLButtonElement>(view.container, "edit-repo-open").textContent).toBe(
      "Edit repository",
    );
    press(field(view.container, "edit-repo-open"));
    expect(field(document, "edit-repo-dialog")).not.toBeNull();
    expect(field<HTMLInputElement>(document, "edit-repo-url").value).toBe(repository.url);
    expect(field<HTMLTextAreaElement>(document, "edit-repo-setup").value).toBe("install");
    expect(field<HTMLButtonElement>(document, "edit-repo-submit").textContent).toBe("Save");
    pressCancel();
    expect(document.querySelector('[data-pw="form-edit-repo"]')).toBeNull();
    view.unmount();
  });

  it("validates a blank URL, normalizes the default branch, and refreshes on success", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<EditRepoForm repository={repository} />);
    press(field(view.container, "edit-repo-open"));
    const form = field<HTMLFormElement>(document, "form-edit-repo");
    setValue(field(document, "edit-repo-url"), "/repo");
    setValue(field(document, "edit-repo-url"), "   ");
    submit(form);
    expect(field(document, "edit-repo-error").textContent).toBe("url is required");
    setValue(field(document, "edit-repo-url"), " /new ");
    setValue(field(document, "edit-repo-branch"), " ");
    submit(form);
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/repositories/repo%2Fone",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      url: "/new",
      defaultBranch: "main",
      setupScript: "install",
      terminalHookScript: "hook",
    });
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-pw="form-edit-repo"]')).toBeNull();
    view.unmount();
  });

  it("sends empty optional scripts, disables save while pending, and reports request errors", async () => {
    let finish!: (res: Response) => void;
    // Typed explicitly so .mock.calls reflects fetch's real (input, init) signature —
    // inferring it from this zero-arg implementation would give an empty-tuple call type.
    const fetch = vi.fn<typeof globalThis.fetch>(
      () => new Promise<Response>((resolve) => (finish = resolve)),
    );
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<EditRepoForm repository={{ id: "repo", url: null }} />);
    press(field(view.container, "edit-repo-open"));
    const form = field<HTMLFormElement>(document, "form-edit-repo");
    setValue(field(document, "edit-repo-url"), "/repo");
    setValue(field(document, "edit-repo-branch"), "feature");
    submit(form);
    expect(field<HTMLButtonElement>(document, "edit-repo-submit").disabled).toBe(true);
    await act(async () =>
      finish(new Response(JSON.stringify({ error: { message: "cannot edit" } }), { status: 409 })),
    );
    expect(field(document, "edit-repo-error").textContent).toBe("cannot edit");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      defaultBranch: "feature",
      setupScript: "",
      terminalHookScript: "",
    });
    view.unmount();
  });

  it("falls back for absent form values", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<EditRepoForm repository={{ id: "repo" }} />);
    press(field(view.container, "edit-repo-open"));
    const form = field<HTMLFormElement>(document, "form-edit-repo");
    setValue(field(document, "edit-repo-url"), "/repo");
    field(document, "edit-repo-branch").remove();
    field(document, "edit-repo-setup").remove();
    field(document, "edit-repo-hook").remove();
    submit(form);
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      url: "/repo",
      defaultBranch: "main",
      setupScript: "",
      terminalHookScript: "",
    });
    view.unmount();
  });

  it("treats an absent URL as required", () => {
    const view = mountForm(<EditRepoForm repository={{ id: "repo" }} />);
    press(field(view.container, "edit-repo-open"));
    const form = field<HTMLFormElement>(document, "form-edit-repo");
    field(document, "edit-repo-url").remove();
    submit(form);
    expect(field(document, "edit-repo-error").textContent).toBe("url is required");
    view.unmount();
  });
});
