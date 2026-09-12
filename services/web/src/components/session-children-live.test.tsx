// @vitest-environment happy-dom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionChildrenLive } from "./session-children-live.tsx";
import { field, json, mountForm } from "../../test-helpers/form-test-helpers.tsx";

afterEach(() => vi.restoreAllMocks());

describe("SessionChildrenLive", () => {
  it("requests the encoded parent's first bounded child page", async () => {
    const request = vi.fn().mockResolvedValue(json({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", request);
    const view = mountForm(
      <SessionChildrenLive
        parentSessionId="parent/one"
        initialItems={[]}
        initialNextCursor="next"
        pollMs={10}
      />,
    );
    expect(field(view.container, "session-detail-children")).toBeTruthy();
    await act(async () => {
      (view.container.querySelector('[data-pw="sessions-load-more"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(request).toHaveBeenCalledWith(
      "/api/v1/sessions/parent%2Fone/children?limit=50&cursor=next",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    view.unmount();
  });

  it("passes an initial child page and error through to the shared panel", () => {
    const view = mountForm(
      <SessionChildrenLive
        parentSessionId="parent"
        initialItems={[{ id: "child", status: "failed" }]}
        initialNextCursor="next"
        initialError="temporarily unavailable"
        pollMs={10}
      />,
    );
    expect(field(view.container, "session-row-child")).toBeTruthy();
    expect(field(view.container, "sessions-live-error").textContent).toContain(
      "temporarily unavailable",
    );
  });
});
