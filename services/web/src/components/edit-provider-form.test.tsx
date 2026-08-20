// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, json, mountForm, press, router, setValue, submit } from "./form-test-helpers.tsx";
import { EditProviderForm } from "./edit-provider-form.tsx";

const provider = {
  id: "provider/one",
  name: "claude",
  defaultCommandId: null,
  createdAt: "now",
  updatedAt: "now",
};

describe("EditProviderForm", () => {
  it("opens its accessible settings form and supports cancel", () => {
    const view = mountForm(<EditProviderForm provider={provider} />);
    press(field(view.container, "edit-provider-open"));
    expect(
      field<HTMLInputElement>(view.container, "edit-provider-name").labels?.[0]?.textContent,
    ).toBe("Name");
    expect(field<HTMLInputElement>(view.container, "edit-provider-name").value).toBe("claude");
    press(
      [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel",
      )!,
    );
    expect(view.container.querySelector('[data-pw="form-edit-provider"]')).toBeNull();
    view.unmount();
  });

  it("saves a trimmed name and refreshes", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<EditProviderForm provider={provider} />);
    press(field(view.container, "edit-provider-open"));
    setValue(field(view.container, "edit-provider-name"), " codex ");
    submit(field(view.container, "form-edit-provider"));
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/providers/provider%2Fone",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ name: "codex" }) }),
    );
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("keeps the form open with parsed or fallback API errors while pending", async () => {
    let finish!: (res: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))),
    );
    const view = mountForm(<EditProviderForm provider={provider} />);
    press(field(view.container, "edit-provider-open"));
    submit(field(view.container, "form-edit-provider"));
    expect(field<HTMLButtonElement>(view.container, "edit-provider-submit").disabled).toBe(true);
    await act(async () => finish(json({ error: { message: "duplicate" } }, 409)));
    expect(field(view.container, "edit-provider-error").textContent).toBe("duplicate");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no json", { status: 503 })));
    submit(field(view.container, "form-edit-provider"));
    await act(async () => Promise.resolve());
    expect(field(view.container, "edit-provider-error").textContent).toBe("no json");
    view.unmount();
  });

  it("submits an empty name when its field is absent", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<EditProviderForm provider={provider} />);
    press(field(view.container, "edit-provider-open"));
    const form = field<HTMLFormElement>(view.container, "form-edit-provider");
    field(view.container, "edit-provider-name").remove();
    submit(form);
    await act(async () => Promise.resolve());
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ body: JSON.stringify({ name: "" }) });
    view.unmount();
  });
});
