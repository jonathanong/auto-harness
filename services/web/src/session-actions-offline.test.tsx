// @vitest-environment happy-dom

import { SessionActions } from "@auto-harness/ui";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, press, router } from "./components/form-test-helpers.tsx";

describe("offline SessionActions", () => {
  it("requires confirmation before using ordinary cancellation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn(async () => ""),
      json: vi.fn(async () => ({})),
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = mountForm(
      <SessionActions sessionId="offline/session" status="running" assignedHostOffline />,
    );

    expect(view.container.querySelector('[data-pw="session-cancel"]')).toBeNull();
    const trigger = field<HTMLButtonElement>(view.container, "session-force-cancel");
    expect(trigger.textContent).toBe("Force-cancel");
    press(trigger);
    expect(field(document, "session-force-cancel-confirm")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      press(field<HTMLButtonElement>(document, "session-force-cancel-confirm-submit"));
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/sessions/offline%2Fsession/cancel", {
      method: "POST",
    });
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });
});
