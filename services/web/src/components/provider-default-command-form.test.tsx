// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it } from "vitest";

import {
  createApiFake,
  field,
  json,
  mountForm,
  router,
  setValue,
  submit,
} from "./form-test-helpers.tsx";
import { ProviderDefaultCommandForm } from "./provider-default-command-form.tsx";

const commands = [
  { id: "command/one", name: "Claude", argv: ["claude"], appendPrompt: true, providerId: "p" },
  { id: "command/two", name: "Codex", argv: ["codex"], appendPrompt: true, providerId: "p" },
] as const;

describe("ProviderDefaultCommandForm", () => {
  it("renders the default selection and saves a command", async () => {
    const api = createApiFake(new Response(null, { status: 204 }));
    const view = mountForm(
      <ProviderDefaultCommandForm
        providerId="provider/one"
        defaultCommandId="command/two"
        commands={[...commands]}
      />,
    );
    const select = field<HTMLSelectElement>(view.container, "provider-default-command-select");
    expect(select.value).toBe("command/two");
    expect([...select.options].map((option) => option.text)).toEqual(["(none)", "Claude", "Codex"]);
    setValue(select, "command/one");
    submit(field(view.container, "form-provider-default-command"));
    await act(async () => Promise.resolve());
    expect(api.requests[0]).toEqual([
      "/api/v1/providers/provider%2Fone",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ defaultCommandId: "command/one" }),
      }),
    ]);
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("clears the default and reports parsed or fallback errors while pending", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => (finish = resolve));
    const api = createApiFake(pending);
    const view = mountForm(
      <ProviderDefaultCommandForm providerId="p" defaultCommandId={null} commands={[]} />,
    );
    const form = field<HTMLFormElement>(view.container, "form-provider-default-command");
    expect(field<HTMLSelectElement>(view.container, "provider-default-command-select").value).toBe(
      "",
    );
    submit(form);
    expect(
      field<HTMLButtonElement>(view.container, "provider-default-command-submit").disabled,
    ).toBe(true);
    expect(field(view.container, "provider-default-command-submit").textContent).toBe("Saving…");
    await act(async () => finish(json({ error: { message: "invalid command" } }, 422)));
    expect(field(view.container, "provider-default-command-error").textContent).toBe(
      "invalid command",
    );
    api.enqueue(new Response("bad", { status: 503 }));
    submit(form);
    await act(async () => Promise.resolve());
    expect(field(view.container, "provider-default-command-error").textContent).toBe(
      "request failed (503)",
    );
    api.enqueue(new Response(null, { status: 204 }));
    field(view.container, "provider-default-command-select").remove();
    submit(form);
    await act(async () => Promise.resolve());
    expect(api.requests[2]).toEqual([
      "/api/v1/providers/p",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ defaultCommandId: null }),
      }),
    ]);
    view.unmount();
  });
});
