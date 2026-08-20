// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, json, mountForm, setValue, submit } from "./form-test-helpers.tsx";
import { CommandCreateForm } from "./command-create-form.tsx";

const providers = [
  { id: "p1", name: "claude", defaultCommandId: null, createdAt: "now", updatedAt: "now" },
];
function fill(view: ReturnType<typeof mountForm>) {
  setValue(field(view.container, "command-catalog-name"), " cmd ");
  setValue(field(view.container, "command-catalog-argv"), " tool \n -p ");
}

describe("CommandCreateForm", () => {
  it("offers the standalone/provider selector and navigates after creation", async () => {
    const navigate = vi.fn();
    const fetch = vi.fn().mockResolvedValue(json({ id: "c/1" }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<CommandCreateForm providers={providers} navigate={navigate} />);
    const select = field<HTMLSelectElement>(view.container, "command-catalog-provider");
    expect(select.labels?.[0]?.textContent).toBe("provider");
    setValue(select, "p1");
    fill(view);
    submit(field(view.container, "form-command-catalog"));
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      name: "cmd",
      argv: ["tool", "-p"],
      appendPrompt: true,
      appendPromptSeparator: true,
      providerId: "p1",
    });
    expect(navigate).toHaveBeenCalledWith("/commands/c/1?toast=Command+created.");
    view.unmount();
  });

  it("resets and refreshes fixed-provider commands, and reports errors while pending", async () => {
    const navigate = vi.fn();
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<CommandCreateForm fixedProviderId="p/1" navigate={navigate} />);
    expect(view.container.querySelector('[data-pw="command-catalog-provider"]')).toBeNull();
    fill(view);
    submit(field(view.container, "form-command-catalog"));
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ providerId: "p/1" });
    expect(navigate).toHaveBeenCalledWith("/");
    expect(field<HTMLTextAreaElement>(view.container, "command-catalog-argv").value).toBe("");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ error: { message: "bad command" } }, 400)),
    );
    fill(view);
    submit(field(view.container, "form-command-catalog"));
    await act(async () => Promise.resolve());
    expect(field(view.container, "command-catalog-error").textContent).toBe("bad command");
    view.unmount();
  });

  it("uses standalone fallbacks and shows a disabled saving control", async () => {
    let finish!: (res: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))),
    );
    const view = mountForm(<CommandCreateForm />);
    const form = field<HTMLFormElement>(view.container, "form-command-catalog");
    form.querySelectorAll("input, textarea").forEach((input) => input.remove());
    submit(form);
    expect(field<HTMLButtonElement>(view.container, "command-catalog-submit").disabled).toBe(true);
    await act(async () => finish(new Response("invalid", { status: 400 })));
    expect(field(view.container, "command-catalog-error").textContent).toBe("invalid");
    view.unmount();
  });
});
