// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, press } from "../../test-helpers/form-test-helpers.tsx";
import { DeleteWorkspacePoolButton } from "./delete-workspace-pool-button.tsx";

describe("DeleteWorkspacePoolButton", () => {
  it("confirms a successful deletion and refreshes the pool list", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<DeleteWorkspacePoolButton poolId="pool/1" />);

    press(field<HTMLButtonElement>(view.container, "delete-workspace-pool-open"));
    press(field<HTMLButtonElement>(view.container, "delete-workspace-pool-confirm-submit"));
    await act(async () => Promise.resolve());

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/workspace-pools/pool%2F1"),
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(field(view.container, "delete-workspace-pool-confirm")).toBeTruthy();
    const { router } = await import("../../test-helpers/form-test-helpers.tsx");
    expect(router.push).toHaveBeenCalledWith("/workspace-pools");
    expect(router.refresh).toHaveBeenCalled();
    view.unmount();
  });

  it("shows a retryable API error and allows cancelling confirmation", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "pool is attached" } }), { status: 409 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<DeleteWorkspacePoolButton poolId="pool-1" />);

    press(field<HTMLButtonElement>(view.container, "delete-workspace-pool-open"));
    press(field<HTMLButtonElement>(view.container, "delete-workspace-pool-confirm-submit"));
    await act(async () => Promise.resolve());
    expect(field(view.container, "delete-workspace-pool-error").textContent).toBe(
      "pool is attached",
    );
    press(field<HTMLButtonElement>(view.container, "mutation-error-retry"));
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(field(view.container, "delete-workspace-pool-confirm")).toBeTruthy();

    const cancel = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel",
    );
    expect(cancel).toBeTruthy();
    press(cancel!);
    expect(view.container.querySelector('[data-pw="delete-workspace-pool-confirm"]')).toBeNull();
    view.unmount();
  });
});
