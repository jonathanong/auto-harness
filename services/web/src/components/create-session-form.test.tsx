// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, json, mountForm, router, setValue, submit } from "./form-test-helpers.tsx";
import { CreateSessionForm } from "./create-session-form.tsx";

const targets = [{ kind: "provider" as const, id: "p/1", label: "Claude" }];

function fill(view: ReturnType<typeof mountForm>) {
  setValue(field(view.container, "create-session-repository-id"), "repo-1");
  setValue(field(view.container, "create-session-prompt"), "Fix the tests");
  setValue(field(view.container, "create-session-ref"), "feature/ref");
  setValue(field(view.container, "create-session-concurrency-id"), "  run-1  ");
  setValue(field(view.container, "create-session-priority"), "80");
}

describe("CreateSessionForm", () => {
  it("validates required fields and navigates after queueing a session", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ id: "session/1" }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <CreateSessionForm targets={targets} availableLabels={["codex", "gpu"]} />,
    );
    const form = field<HTMLFormElement>(view.container, "form-create-session");
    expect(form.checkValidity()).toBe(false);
    fill(view);
    field<HTMLInputElement>(view.container, "create-session-label-gpu").click();
    expect(form.checkValidity()).toBe(true);
    submit(form);
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      repositoryId: "repo-1",
      prompt: "Fix the tests",
      target: { providerId: "p/1" },
      fallbacks: [],
      queueTtlSeconds: 691200,
      timeout: 600,
      priority: 80,
      requiredLabels: ["gpu"],
      ref: "feature/ref",
      concurrencyId: "run-1",
      source: "ui",
    });
    expect(router.push).toHaveBeenCalledWith("/sessions/session%2F1?toast=Session+queued.");
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("shows duplicate routing and handles a successful non-JSON response", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ created: false, activeSessionId: "active/1", id: "ignored" }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<CreateSessionForm targets={targets} />);
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
    const view = mountForm(<CreateSessionForm targets={targets} />);
    fill(view);
    submit(field(view.container, "form-create-session"));
    expect(field<HTMLButtonElement>(view.container, "create-session-submit").disabled).toBe(true);
    expect(field<HTMLButtonElement>(view.container, "create-session-submit").textContent).toBe(
      "Creating…",
    );
    await act(async () => finish(new Response("capacity unavailable", { status: 409 })));
    expect(field(view.container, "create-session-error").textContent).toBe("capacity unavailable");
    view.unmount();

    const empty = mountForm(<CreateSessionForm targets={[]} />);
    expect(field<HTMLButtonElement>(empty.container, "create-session-submit").disabled).toBe(true);
    empty.unmount();
  });

  it("submits editable cloned inputs without inheriting concurrency", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ id: "edited-clone" }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <CreateSessionForm
        targets={[...targets, { kind: "provider" as const, id: "fallback", label: "Fallback" }]}
        availableLabels={["gpu"]}
        initialValues={{
          repositoryId: "source-repository",
          prompt: "source prompt",
          target: { providerId: "p/1" },
          fallbacks: [{ providerId: "fallback" }],
          queueTtlSeconds: 90,
          timeout: 0.5,
          priority: -20,
          requiredLabels: ["gpu"],
          ref: "source/ref",
        }}
      />,
    );
    expect(field<HTMLInputElement>(view.container, "create-session-concurrency-id").value).toBe("");
    expect(field<HTMLInputElement>(view.container, "create-session-label-gpu").checked).toBe(true);
    const priority = field<HTMLInputElement>(view.container, "create-session-priority");
    expect(priority.min).toBe("-20");
    expect(priority.max).toBe("100");
    expect(field(view.container, "create-session-priority-value").textContent).toBe("-20 (low)");
    expect(field<HTMLInputElement>(view.container, "create-session-timeout").step).toBe("any");
    submit(field(view.container, "form-create-session"));
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      repositoryId: "source-repository",
      prompt: "source prompt",
      target: { providerId: "p/1" },
      fallbacks: [{ providerId: "fallback" }],
      queueTtlSeconds: 90,
      timeout: 0.5,
      priority: -20,
      requiredLabels: ["gpu"],
      ref: "source/ref",
      source: "ui",
    });
    view.unmount();
  });
});
