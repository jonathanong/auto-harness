// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, json, mountForm, router, setValue, submit } from "./form-test-helpers.tsx";
import { ProviderCreateForm } from "./provider-create-form.tsx";

function fill(view: ReturnType<typeof mountForm>) {
  setValue(field(view.container, "provider-catalog-name"), " codex ");
  setValue(field(view.container, "provider-catalog-command-name"), " codex-run ");
  setValue(field(view.container, "provider-catalog-argv"), " codex \n -p \n");
}

describe("ProviderCreateForm", () => {
  it("keeps accessible provider command fields and creates then links the default command", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ id: "p/1" }))
      .mockResolvedValueOnce(json({ id: "c/1" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<ProviderCreateForm />);
    expect(
      field<HTMLInputElement>(view.container, "provider-catalog-name").labels?.[0]?.textContent,
    ).toBe("name");
    expect(field<HTMLInputElement>(view.container, "provider-catalog-append-prompt").checked).toBe(
      true,
    );
    expect(
      field<HTMLInputElement>(view.container, "provider-catalog-append-prompt-separator").checked,
    ).toBe(true);
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
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ id: "p/1" }))
      .mockResolvedValueOnce(json({ id: "c/1" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<ProviderCreateForm />);
    act(() => {
      setValue(field(view.container, "provider-catalog-name"), "grok");
    });
    expect(field<HTMLInputElement>(view.container, "provider-catalog-command-name").value).toBe(
      "grok-print",
    );
    expect(field<HTMLTextAreaElement>(view.container, "provider-catalog-argv").value).toBe(
      "grok\n--always-approve\n--max-turns\n3\n-p",
    );
    expect(
      field<HTMLInputElement>(view.container, "provider-catalog-append-prompt-separator").checked,
    ).toBe(false);
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

  it("keeps edited grok argv when the name only gains trailing whitespace", () => {
    const view = mountForm(<ProviderCreateForm />);
    act(() => {
      setValue(field(view.container, "provider-catalog-name"), "grok");
    });
    act(() => {
      setValue(field(view.container, "provider-catalog-argv"), "grok\n-p\n--custom");
    });
    act(() => {
      setValue(field(view.container, "provider-catalog-name"), "grok ");
    });
    expect(field<HTMLTextAreaElement>(view.container, "provider-catalog-argv").value).toBe(
      "grok\n-p\n--custom",
    );
    view.unmount();
  });

  it("submits appendPromptSeparator: false once unchecked, for tools like printf that treat -- as data", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ id: "p/1" }))
      .mockResolvedValueOnce(json({ id: "c/1" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<ProviderCreateForm />);
    fill(view);
    const separator = field<HTMLInputElement>(
      view.container,
      "provider-catalog-append-prompt-separator",
    );
    act(() => {
      separator.click();
    });
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
    form.querySelectorAll("input, textarea").forEach((input) => input.remove());
    submit(form);
    expect(field<HTMLButtonElement>(view.container, "provider-catalog-submit").disabled).toBe(true);
    await act(async () => finish(new Response("", { status: 500 })));
    expect(field(view.container, "provider-catalog-error").textContent).toBe(
      "request failed (500)",
    );
    view.unmount();
  });
});
