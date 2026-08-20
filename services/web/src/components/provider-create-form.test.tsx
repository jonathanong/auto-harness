// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, json, mountForm, router, setValue, submit } from "./form-test-helpers.tsx";
import { ProviderCreateForm } from "./provider-create-form.tsx";

type View = ReturnType<typeof mountForm>;

function fill(view: View) {
  setValue(field(view.container, "provider-catalog-name"), " codex ");
  setValue(field(view.container, "provider-catalog-command-name"), " codex-run ");
  setValue(field(view.container, "provider-catalog-argv"), " codex \n -p \n");
}

function input<T extends HTMLElement>(view: View, pw: string) {
  return field<T>(view.container, pw);
}

function setName(view: View, value: string) {
  act(() => setValue(input<HTMLInputElement>(view, "provider-catalog-name"), value));
}

function expectCommand(view: View, name: string, argv: string, separator: boolean) {
  expect(input<HTMLInputElement>(view, "provider-catalog-command-name").value).toBe(name);
  expect(input<HTMLTextAreaElement>(view, "provider-catalog-argv").value).toBe(argv);
  expect(input<HTMLInputElement>(view, "provider-catalog-append-prompt-separator").checked).toBe(
    separator,
  );
}

function mockCreate() {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json({ id: "p/1" }))
    .mockResolvedValueOnce(json({ id: "c/1" }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("ProviderCreateForm", () => {
  it("keeps accessible provider command fields and creates then links the default command", async () => {
    const fetch = mockCreate();
    const view = mountForm(<ProviderCreateForm />);
    expect(input<HTMLInputElement>(view, "provider-catalog-name").labels?.[0]?.textContent).toBe(
      "name",
    );
    expect(input<HTMLInputElement>(view, "provider-catalog-append-prompt").checked).toBe(true);
    expect(input<HTMLInputElement>(view, "provider-catalog-append-prompt-separator").checked).toBe(
      true,
    );
    fill(view);
    submit(field(view.container, "form-provider-catalog"));
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ name: "codex" });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      name: "codex-run",
      argv: ["codex", "-p"],
      appendPrompt: true,
      appendPromptSeparator: true,
      providerId: "p/1",
    });
    expect(fetch.mock.calls[2]?.[0]).toBe("/api/v1/providers/p%2F1");
    expect(router.push).toHaveBeenCalledWith("/providers/p/1?toast=Provider+created.");
    view.unmount();
  });

  it("applies grok catalog defaults without a -- separator or --output-format plain", async () => {
    const fetch = mockCreate();
    const view = mountForm(<ProviderCreateForm />);
    setName(view, "grok");
    expectCommand(view, "grok-print", "grok\n--always-approve\n--max-turns\n3\n-p", false);
    submit(field(view.container, "form-provider-catalog"));
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      name: "grok-print",
      argv: ["grok", "--always-approve", "--max-turns", "3", "-p"],
      appendPrompt: true,
      appendPromptSeparator: false,
      providerId: "p/1",
    });
    view.unmount();
  });

  it("switches from grok defaults to claude defaults when the provider name changes", () => {
    const view = mountForm(<ProviderCreateForm />);
    setName(view, "grok");
    setName(view, "claude");
    expectCommand(view, "claude-print", "claude\n-p", true);
    view.unmount();
  });

  it("applies codex exec and cursor-agent print presets with a -- separator", () => {
    const view = mountForm(<ProviderCreateForm />);
    setName(view, "codex");
    expectCommand(view, "codex-exec", "codex\nexec", true);
    setName(view, "cursor-agent");
    expectCommand(view, "cursor-print", "cursor-agent\n--print\n--force", true);
    setName(view, "cursor");
    expectCommand(view, "cursor-print", "cursor-agent\n--print\n--force", true);
    view.unmount();
  });

  it("keeps a custom command name when switching catalog providers", () => {
    const view = mountForm(<ProviderCreateForm />);
    setName(view, "grok");
    act(() => setValue(input<HTMLInputElement>(view, "provider-catalog-command-name"), "my-cli"));
    setName(view, "claude");
    expectCommand(view, "my-cli", "claude\n-p", true);
    view.unmount();
  });

  it("does not wipe grok defaults when the name becomes a non-catalog value", () => {
    const view = mountForm(<ProviderCreateForm />);
    setName(view, "grok");
    setName(view, "other");
    expectCommand(view, "grok-print", "grok\n--always-approve\n--max-turns\n3\n-p", false);
    view.unmount();
  });

  it("keeps edited grok argv when the name only gains trailing whitespace", () => {
    const view = mountForm(<ProviderCreateForm />);
    setName(view, "grok");
    act(() =>
      setValue(input<HTMLTextAreaElement>(view, "provider-catalog-argv"), "grok\n-p\n--custom"),
    );
    setName(view, "grok ");
    expect(input<HTMLTextAreaElement>(view, "provider-catalog-argv").value).toBe(
      "grok\n-p\n--custom",
    );
    view.unmount();
  });

  it("submits appendPromptSeparator: false once unchecked, for tools like printf that treat -- as data", async () => {
    const fetch = mockCreate();
    const view = mountForm(<ProviderCreateForm />);
    fill(view);
    const appendPrompt = input<HTMLInputElement>(view, "provider-catalog-append-prompt");
    const separator = input<HTMLInputElement>(view, "provider-catalog-append-prompt-separator");
    act(() => {
      appendPrompt.click();
      separator.click();
    });
    expect(appendPrompt.checked).toBe(false);
    expect(separator.checked).toBe(false);
    submit(field(view.container, "form-provider-catalog"));
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      appendPromptSeparator: false,
    });
    view.unmount();
  });

  it("reports provider, command, and link failures with parsed or fallback errors", async () => {
    const cases = [
      [json({ error: { message: "taken" } }, 409), "taken"],
      [
        json({ id: "p" }),
        new Response("bad", { status: 502 }),
        'provider "codex" created, but its default command failed: request failed (502)',
      ],
      [
        json({ id: "p" }),
        json({ id: "c" }),
        json({}, 500),
        'provider "codex" and command "codex-run" created, but linking the default failed: request failed (500)',
      ],
    ] as const;
    for (const responses of cases) {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(responses[0])
          .mockResolvedValueOnce(responses[1])
          .mockResolvedValueOnce(responses[2]),
      );
      const view = mountForm(<ProviderCreateForm />);
      fill(view);
      submit(field(view.container, "form-provider-catalog"));
      await act(async () => Promise.resolve());
      expect(field(view.container, "provider-catalog-error").textContent).toBe(responses.at(-1));
      view.unmount();
    }
  });

  it("uses empty form fallbacks and disables submit while the provider request is pending", async () => {
    let finish!: (res: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))),
    );
    const view = mountForm(<ProviderCreateForm />);
    const form = field<HTMLFormElement>(view.container, "form-provider-catalog");
    form.querySelectorAll("input, textarea").forEach((el) => el.remove());
    submit(form);
    expect(input<HTMLButtonElement>(view, "provider-catalog-submit").disabled).toBe(true);
    await act(async () => finish(new Response("", { status: 500 })));
    expect(field(view.container, "provider-catalog-error").textContent).toBe(
      "request failed (500)",
    );
    view.unmount();
  });
});
