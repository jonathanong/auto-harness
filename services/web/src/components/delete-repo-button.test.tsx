// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, press, router } from "./form-test-helpers.tsx";
import { DeleteRepoButton } from "./delete-repo-button.tsx";

function open(view: ReturnType<typeof mountForm>) {
  press(field<HTMLButtonElement>(view.container, "delete-repo-open"));
}

function confirm() {
  return field<HTMLButtonElement>(document, "delete-repo-confirm-submit");
}

describe("DeleteRepoButton", () => {
  it("explains attached hosts and the unreferenced case", () => {
    for (const [attachedHostCount, message] of [
      [1, "Attached to 1 host"],
      [2, "Attached to 2 hosts"],
      [0, "Permanently remove this repository"],
    ] as const) {
      const view = mountForm(
        <DeleteRepoButton repositoryId="repo/1" attachedHostCount={attachedHostCount} />,
      );
      open(view);
      expect(field(document, "delete-repo-confirm").textContent).toContain(message);
      view.unmount();
    }
  });

  it("confirms a successful deletion with pending state and navigates", async () => {
    let finish!: (response: Response) => void;
    const request = vi.fn(() => new Promise<Response>((resolve) => (finish = resolve)));
    const view = mountForm(
      <DeleteRepoButton repositoryId="repo/1" attachedHostCount={0} request={request} />,
    );
    open(view);
    press(confirm());
    expect(confirm().disabled).toBe(true);
    expect(confirm().textContent).toBe("Deleting…");
    await act(async () => finish(new Response(null, { status: 204 })));
    expect(router.push).toHaveBeenCalledWith("/repositories");
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("shows a response body when deletion fails and supports cancel", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response("repository has attachments", { status: 409 }));
    const view = mountForm(
      <DeleteRepoButton repositoryId="repo/1" attachedHostCount={1} request={request} />,
    );
    open(view);
    press(confirm());
    await act(async () => Promise.resolve());
    expect(field(document, "delete-repo-error").textContent).toBe("repository has attachments");
    press(field<HTMLButtonElement>(document, "delete-repo-confirm").querySelectorAll("button")[1]!);
    expect(document.querySelector('[data-pw="delete-repo-confirm"]')).toBeNull();
    view.unmount();
  });
});
