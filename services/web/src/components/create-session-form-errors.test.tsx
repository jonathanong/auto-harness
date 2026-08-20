// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, json, mountForm, router, setValue, submit } from "./form-test-helpers.tsx";
import { CreateSessionForm } from "./create-session-form.tsx";

const targets = [{ kind: "provider" as const, id: "p/1", label: "Claude" }];
const repositories = [{ id: "repo-1", name: "repo-one" }];

function fill(view: ReturnType<typeof mountForm>) {
  setValue(field(view.container, "create-session-prompt"), "Fix the tests");
  setValue(field(view.container, "create-session-ref"), "feature/ref");
  setValue(field(view.container, "create-session-concurrency-id"), "  run-1  ");
  setValue(field(view.container, "create-session-priority"), "80");
}

describe("CreateSessionForm errors", () => {
  it("shows duplicate routing and handles a successful non-JSON response", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ created: false, activeSessionId: "active/1", id: "ignored" }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<CreateSessionForm targets={targets} repositories={repositories} />);
    fill(view);
    submit(field(view.container, "form-create-session"));
    await act(async () => Promise.resolve());
    expect(router.push).toHaveBeenCalledWith(
      "/sessions/active%2F1?toast=A+session+with+this+concurrency+ID+is+already+active%3B+showing+it+instead.",
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("ok"))
        .mockResolvedValueOnce(json({}))
        .mockResolvedValueOnce(json({ created: false })),
    );
    view.container.querySelectorAll("input, textarea").forEach((input) => input.remove());
    submit(field(view.container, "form-create-session"));
    await act(async () => Promise.resolve());
    expect(router.push).toHaveBeenLastCalledWith("/sessions?toast=Session+queued.");
    submit(field(view.container, "form-create-session"));
    await act(async () => Promise.resolve());
    expect(router.push).toHaveBeenLastCalledWith("/sessions?toast=Session+queued.");
    submit(field(view.container, "form-create-session"));
    await act(async () => Promise.resolve());
    expect(router.push).toHaveBeenLastCalledWith(
      "/sessions?toast=A+session+with+this+concurrency+ID+is+already+active%3B+showing+it+instead.",
    );
    view.unmount();
  });

  it("reports errors while pending and disables submit when no targets exist", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))),
    );
    const view = mountForm(<CreateSessionForm targets={targets} repositories={repositories} />);
    fill(view);
    submit(field(view.container, "form-create-session"));
    expect(field<HTMLButtonElement>(view.container, "create-session-submit").disabled).toBe(true);
    expect(field<HTMLButtonElement>(view.container, "create-session-submit").textContent).toBe(
      "Creating…",
    );
    await act(async () =>
      finish(
        new Response(JSON.stringify({ error: { message: "capacity unavailable" } }), {
          status: 409,
        }),
      ),
    );
    expect(field(view.container, "create-session-error").textContent).toBe("capacity unavailable");
    expect(field<HTMLButtonElement>(view.container, "create-session-submit").disabled).toBe(false);
    view.unmount();

    const empty = mountForm(<CreateSessionForm targets={targets} repositories={[]} />);
    expect(field<HTMLButtonElement>(empty.container, "create-session-submit").disabled).toBe(true);
    expect(field<HTMLSelectElement>(empty.container, "create-session-repository-id").value).toBe(
      "",
    );
    empty.unmount();

    const noTargets = mountForm(<CreateSessionForm targets={[]} repositories={repositories} />);
    expect(field<HTMLButtonElement>(noTargets.container, "create-session-submit").disabled).toBe(
      true,
    );
    noTargets.unmount();
  });
});
