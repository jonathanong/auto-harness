// @vitest-environment happy-dom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UserSessionsLive } from "./user-sessions-live.tsx";
import { createRequestFake, field, json, mountForm } from "./form-test-helpers.tsx";

afterEach(() => vi.useRealTimers());

describe("UserSessionsLive", () => {
  it("replaces the server snapshot after a client poll", async () => {
    vi.useFakeTimers();
    const request = createRequestFake(
      json({
        items: [
          {
            id: "viewer-live",
            userId: "user:alice",
            username: "alice",
            role: "operator",
            kind: "user",
            connectedAt: "2026-09-06T00:00:00.000Z",
            lastHeartbeatAt: "2026-09-06T00:00:00.000Z",
            subscriptions: [{ sessionId: "sess-1", repositoryId: "repo-1", status: "running" }],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", request.request);
    const view = mountForm(<UserSessionsLive initialItems={[]} initialError={null} pollMs={10} />);
    expect(field(view.container, "user-sessions-empty")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(field(view.container, "user-sessions-table")).toBeTruthy();
    expect(field(view.container, "user-session-user-viewer-live").textContent).toBe("alice");
    expect(request.requests.map(([input]) => String(input))).toEqual(["/api/v1/user-sessions"]);
  });
});
