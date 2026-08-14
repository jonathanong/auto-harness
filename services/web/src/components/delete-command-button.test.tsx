// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createRequestFake, field, mountForm, press } from "./form-test-helpers.tsx";
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
    const navigate = vi.fn();
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => (finish = resolve));
    const { request, requests } = createRequestFake(pending);
    const view = mountForm(
      <DeleteCommandButton commandId="command/1" request={request} navigate={navigate} />,
    );
    open(view);
    expect(field(document, "delete-command-confirm").textContent).toContain(
      "Permanently remove this command",
    );
    press(field<HTMLButtonElement>(document, "delete-command-confirm-submit"));
    expect(confirm().disabled).toBe(true);
    expect(confirm().textContent).toBe("Deleting…");
    await act(async () => finish(new Response(null, { status: 204 })));
    expect(requests).toEqual([
      ["/api/v1/commands/command%2F1", expect.objectContaining({ method: "DELETE" })],
    ]);
    expect(navigate).toHaveBeenCalledWith("/commands");
    view.unmount();

    const cancelView = mountForm(<DeleteCommandButton commandId="command/2" request={request} />);
    open(cancelView);
    press(
      [...field(document, "delete-command-confirm").querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel",
      )!,
    );
    expect(document.querySelector('[data-pw="delete-command-confirm"]')).toBeNull();
    cancelView.unmount();
  });

  it("renders API messages in a retry toast and retries successfully", async () => {
    const navigate = vi.fn();
    const { request, enqueue } = createRequestFake(
      new Response(JSON.stringify({ error: { message: "command is in use" } }), {
        status: 409,
      }),
    );
    const parsedView = mountForm(
      <DeleteCommandButton commandId="command/1" request={request} navigate={navigate} />,
    );
    open(parsedView);
    press(confirm());
    await act(async () => Promise.resolve());
    expect(field(document, "mutation-error-toast").getAttribute("role")).toBe("alert");
    expect(field(document, "delete-command-error").textContent).toBe("command is in use");
    enqueue(new Response(null, { status: 204 }));
    await act(async () => {
      field<HTMLButtonElement>(document, "mutation-error-retry").click();
      await Promise.resolve();
    });
    expect(navigate).toHaveBeenCalledWith("/commands");
    parsedView.unmount();

    enqueue(new Response("not json", { status: 503 }));
    const fallbackView = mountForm(<DeleteCommandButton commandId="command/2" request={request} />);
    open(fallbackView);
    press(confirm());
    await act(async () => Promise.resolve());
    expect(field(document, "delete-command-error").textContent).toBe("request failed (503)");
    press(
      [...field(document, "delete-command-confirm").querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel",
      )!,
    );
    expect(document.querySelector('[data-pw="mutation-error-toast"]')).toBeNull();
    fallbackView.unmount();
  });
});
