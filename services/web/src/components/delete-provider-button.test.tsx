// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it } from "vitest";

import { createRequestFake, field, mountForm, press, router } from "./form-test-helpers.tsx";
import { DeleteProviderButton } from "./delete-provider-button.tsx";

function open(view: ReturnType<typeof mountForm>) {
  press(field<HTMLButtonElement>(view.container, "delete-provider-open"));
}

function confirm() {
  return field<HTMLButtonElement>(document, "delete-provider-confirm-submit");
}

describe("DeleteProviderButton", () => {
  it("disables deletion when accounts or commands remain", () => {
    for (const props of [
      { accountCount: 1, commandCount: 0 },
      { accountCount: 0, commandCount: 1 },
    ]) {
      const view = mountForm(<DeleteProviderButton providerId="provider/1" {...props} />);
      expect(field<HTMLButtonElement>(view.container, "delete-provider-open").disabled).toBe(true);
      view.unmount();
    }
  });

  it("confirms a successful deletion with a pending label and supports cancel", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => (finish = resolve));
    const { request, requests } = createRequestFake(pending);
    const view = mountForm(
      <DeleteProviderButton
        providerId="provider/1"
        accountCount={0}
        commandCount={0}
        request={request}
      />,
    );
    open(view);
    press(confirm());
    expect(confirm().disabled).toBe(true);
    expect(confirm().textContent).toBe("Deleting…");
    await act(async () => finish(new Response(null, { status: 204 })));
    expect(requests).toEqual([
      ["/api/v1/providers/provider%2F1", expect.objectContaining({ method: "DELETE" })],
    ]);
    expect(router.push).toHaveBeenCalledWith("/providers");
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();

    const cancelView = mountForm(
      <DeleteProviderButton
        providerId="provider/2"
        accountCount={0}
        commandCount={0}
        request={request}
      />,
    );
    open(cancelView);
    press(
      field<HTMLButtonElement>(document, "delete-provider-confirm").querySelectorAll("button")[1]!,
    );
    expect(document.querySelector('[data-pw="delete-provider-confirm"]')).toBeNull();
    cancelView.unmount();
  });

  it("renders parsed API errors in a retry toast and status fallbacks", async () => {
    const { request, enqueue } = createRequestFake(
      new Response(JSON.stringify({ error: { message: "provider is busy" } }), { status: 409 }),
    );
    const parsedView = mountForm(
      <DeleteProviderButton
        providerId="provider/1"
        accountCount={0}
        commandCount={0}
        request={request}
      />,
    );
    open(parsedView);
    press(confirm());
    await act(async () => Promise.resolve());
    expect(field(document, "mutation-error-toast").getAttribute("role")).toBe("alert");
    expect(field(document, "delete-provider-error").textContent).toBe("provider is busy");
    parsedView.unmount();

    enqueue(new Response("not json", { status: 502 }));
    const fallbackView = mountForm(
      <DeleteProviderButton
        providerId="provider/2"
        accountCount={0}
        commandCount={0}
        request={request}
      />,
    );
    open(fallbackView);
    press(confirm());
    await act(async () => Promise.resolve());
    expect(field(document, "delete-provider-error").textContent).toBe("request failed (502)");
    fallbackView.unmount();
  });
});
