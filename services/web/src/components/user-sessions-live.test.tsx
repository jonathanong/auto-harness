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
    expect(request.requests.map(([input]) => String(input))).toEqual([
      "/api/v1/user-sessions?limit=100",
    ]);
  });

  it("surfaces a poll failure without dropping the last snapshot", async () => {
    vi.useFakeTimers();
    const request = createRequestFake(json({ items: [] }, 503));
    vi.stubGlobal("fetch", request.request);
    const view = mountForm(<UserSessionsLive initialItems={[]} initialError={null} pollMs={10} />);
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(field(view.container, "user-sessions-api-error").textContent).toContain(
      "GET /api/v1/user-sessions",
    );
    view.unmount();
  });

  it("treats a missing items array as empty and stringifies non-Error poll failures", async () => {
    vi.useFakeTimers();
    const request = createRequestFake(json({}), () => {
      throw "viewer-offline";
    });
    vi.stubGlobal("fetch", request.request);
    const view = mountForm(
      <UserSessionsLive
        initialItems={[
          {
            id: "viewer-live",
            userId: "user:alice",
            username: "alice",
            role: "operator",
            kind: "user",
            connectedAt: "2026-09-06T00:00:00.000Z",
            lastHeartbeatAt: "2026-09-06T00:00:00.000Z",
            subscriptions: [
              { sessionId: "sess-1", repositoryId: "repo-1", status: "running" },
              { sessionId: "sess-2", repositoryId: "repo-1", status: "queued" },
            ],
          },
        ]}
        initialError={null}
        pollMs={10}
      />,
    );
    expect(field(view.container, "user-session-watch-sess-1")).toBeTruthy();
    expect(field(view.container, "user-session-watch-sess-2")).toBeTruthy();
    expect(field(view.container, "user-sessions-table").textContent).toContain(",");
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(field(view.container, "user-sessions-empty")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(field(view.container, "user-sessions-api-error").textContent).toContain(
      "viewer-offline",
    );
    view.unmount();
  });

  it("ignores a poll that settles after unmount", async () => {
    vi.useFakeTimers();
    let resolvePoll: ((value: Response) => void) | undefined;
    const request = createRequestFake(
      () =>
        new Promise<Response>((resolve) => {
          resolvePoll = resolve;
        }),
    );
    vi.stubGlobal("fetch", request.request);
    const view = mountForm(<UserSessionsLive initialItems={[]} initialError={null} pollMs={10} />);
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(resolvePoll).toBeDefined();
    view.unmount();
    await act(async () => resolvePoll?.(json({ items: [{ id: "late" }] })));
  });
});
