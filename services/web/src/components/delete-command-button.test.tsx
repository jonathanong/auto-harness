// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, press, router } from "./form-test-helpers.tsx";
import { DeleteCommandButton } from "./delete-command-button.tsx";

function open(view: ReturnType<typeof mountForm>) {
  press(field<HTMLButtonElement>(view.container, "delete-command-open"));
}

function confirm() {
  return field<HTMLButtonElement>(document, "delete-command-confirm-submit");
}

describe("DeleteCommandButton", () => {
  it("disables deletion while the command is a provider default", () => {
    const view = mountForm(
      <DeleteCommandButton commandId="command/1" defaultForProviderName="codex" />,
    );
    const button = field<HTMLButtonElement>(view.container, "delete-command-open");
    expect(button.disabled).toBe(true);
    expect(document.querySelector('[data-pw="delete-command-confirm"]')).toBeNull();
    view.unmount();
  });

  it("confirms a successful deletion, shows pending state, and supports cancel", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))),
    );
    const view = mountForm(<DeleteCommandButton commandId="command/1" />);
    open(view);
    expect(field(document, "delete-command-confirm").textContent).toContain(
      "Permanently remove this command",
    );
    press(field<HTMLButtonElement>(document, "delete-command-confirm-submit"));
    expect(confirm().disabled).toBe(true);
    expect(confirm().textContent).toBe("Deleting…");
    await act(async () => finish(new Response(null, { status: 204 })));
    expect(router.push).toHaveBeenCalledWith("/commands");
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();

    const cancelView = mountForm(<DeleteCommandButton commandId="command/2" />);
    open(cancelView);
    press(
      field<HTMLButtonElement>(document, "delete-command-confirm").querySelectorAll("button")[1]!,
    );
    expect(document.querySelector('[data-pw="delete-command-confirm"]')).toBeNull();
    cancelView.unmount();
  });

  it("renders API messages and status fallbacks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "command is in use" } }), {
          status: 409,
        }),
      ),
    );
    const parsedView = mountForm(<DeleteCommandButton commandId="command/1" />);
    open(parsedView);
    press(confirm());
    await act(async () => Promise.resolve());
    expect(field(document, "delete-command-error").textContent).toBe("command is in use");
    parsedView.unmount();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 503 })));
    const fallbackView = mountForm(<DeleteCommandButton commandId="command/2" />);
    open(fallbackView);
    press(confirm());
    await act(async () => Promise.resolve());
    expect(field(document, "delete-command-error").textContent).toBe("request failed (503)");
    fallbackView.unmount();
  });
});
