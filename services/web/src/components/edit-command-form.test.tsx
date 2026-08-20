// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, json, mountForm, press, router, setValue, submit } from "./form-test-helpers.tsx";
import { EditCommandForm } from "./edit-command-form.tsx";

const command = {
  id: "c/1",
  name: "claude-run",
  argv: ["claude", "-p"],
  appendPrompt: true,
  providerId: "p1",
  createdAt: "now",
  updatedAt: "now",
};
const providers = [
  { id: "p1", name: "claude", defaultCommandId: null, createdAt: "now", updatedAt: "now" },
];

describe("EditCommandForm", () => {
  it("opens accessible command fields and saves normalized command data", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<EditCommandForm command={command} providers={providers} />);
    press(field(view.container, "edit-command-open"));
    expect(field<HTMLTextAreaElement>(view.container, "edit-command-argv").value).toBe(
      "claude\n-p",
    );
    expect(
      field<HTMLSelectElement>(view.container, "edit-command-provider").labels?.[0]?.textContent,
    ).toBe("Provider");
    setValue(field(view.container, "edit-command-name"), " codex ");
    setValue(field(view.container, "edit-command-argv"), " codex \n -p ");
    setValue(field(view.container, "edit-command-provider"), "");
    press(field(view.container, "edit-command-append-prompt"));
    submit(field(view.container, "form-edit-command"));
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      name: "codex",
      argv: ["codex", "-p"],
      appendPrompt: false,
      appendPromptSeparator: false,
      providerId: null,
    });
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("cancels, exposes pending Save, and parses API failures", async () => {
    let finish!: (res: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))),
    );
    const view = mountForm(<EditCommandForm command={command} providers={providers} />);
    press(field(view.container, "edit-command-open"));
    submit(field(view.container, "form-edit-command"));
    expect(field<HTMLButtonElement>(view.container, "edit-command-submit").disabled).toBe(true);
    await act(async () => finish(json({ error: { message: "duplicate" } }, 409)));
    expect(field(view.container, "edit-command-error").textContent).toBe("duplicate");
    press(
      [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel",
      )!,
    );
    expect(view.container.querySelector('[data-pw="form-edit-command"]')).toBeNull();
    view.unmount();
  });

  it("uses absent command fields and fallback API errors", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("bad", { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(
      <EditCommandForm command={{ ...command, providerId: null }} providers={[]} />,
    );
    press(field(view.container, "edit-command-open"));
    const form = field<HTMLFormElement>(view.container, "form-edit-command");
    form.querySelectorAll("input, textarea, select").forEach((input) => input.remove());
    submit(form);
    await act(async () => Promise.resolve());
    expect(field(view.container, "edit-command-error").textContent).toBe("bad");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      name: "",
      argv: [],
      appendPrompt: false,
      appendPromptSeparator: false,
      providerId: null,
    });
    view.unmount();
  });
});
