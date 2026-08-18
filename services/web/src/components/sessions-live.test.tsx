// @vitest-environment happy-dom

import React, { act, useState } from "react";
import type { SessionListQuery } from "@auto-harness/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionsLive } from "./sessions-live.tsx";
import { createRequestFake, field, json, mountForm, press } from "./form-test-helpers.tsx";

afterEach(() => vi.useRealTimers());

const listState: SessionListQuery = {
  concurrencyId: "",
  cursor: "",
  hostId: "",
  limit: 50,
  q: "",
  repositoryId: "",
  scheduleId: "",
  sort: "latest",
  source: "",
  status: "all",
};

describe("SessionsLive", () => {
  it.each([
    ["source", { ...listState, source: "manual" }],
    ["agent", { ...listState, hostId: "host-1" }],
  ] satisfies ReadonlyArray<readonly [string, SessionListQuery]>)(
    "treats an active %s filter as a narrowed list",
    (_label, filteredState) => {
      const view = mountForm(
        <SessionsLive
          initialItems={[]}
          initialNextCursor={null}
          listState={filteredState}
          path="/api/v1/sessions"
        />,
      );
      expect(view.container.textContent).toContain("No sessions match filters.");
      expect(view.container.textContent).not.toContain("Create your first session");
    },
  );

  it("polls the bounded current page and updates session rows", async () => {
    vi.useFakeTimers();
    const request = createRequestFake(
      json({
        items: [{ id: "live", status: "running", repositoryId: "repo-1" }],
        nextCursor: "next-live",
      }),
    );
    vi.stubGlobal("fetch", request.request);
    const view = mountForm(
      <SessionsLive
        initialItems={[]}
        initialNextCursor={null}
        listState={listState}
        path="/api/v1/sessions?status=running"
        pollMs={10}
        repositoryNames={{ "repo-1": "Harness" }}
      />,
    );
    expect(view.container.textContent).toContain("No sessions yet");
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(field(view.container, "session-row-live")).toBeTruthy();
    const repository = field<HTMLTableCellElement>(view.container, "session-repository-live");
    expect(repository.textContent).toBe("Harness");
    expect(repository.querySelector("a")?.getAttribute("href")).toBe("/repositories/repo-1");
    expect(field<HTMLButtonElement>(view.container, "sessions-load-more").textContent).toBe(
      "Load more",
    );
    expect(String(request.requests[0]?.[0])).toBe("/api/v1/sessions?status=running");
  });

  it("shows a paused state, retains rows, and recovers on retry", async () => {
    vi.useFakeTimers();
    const request = createRequestFake(
      new Response(null, { status: 503 }),
      json({ items: [{ id: "fresh", status: "completed" }] }),
    );
    vi.stubGlobal("fetch", request.request);
    const view = mountForm(
      <SessionsLive
        initialItems={[{ id: "old", status: "queued" }]}
        initialNextCursor={null}
        listState={listState}
        path="/api/v1/sessions"
        pollMs={10}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(field(view.container, "sessions-live-error")).toBeTruthy();
    expect(field(view.container, "session-row-old")).toBeTruthy();
    await act(async () =>
      press(field(view.container, "sessions-live-error").querySelector("button")!),
    );
    expect(field(view.container, "session-row-fresh")).toBeTruthy();
    expect(field(view.container, "sessions-live-active")).toBeTruthy();
  });

  it("shows the first-session guidance when polling empties the loaded list", async () => {
    vi.useFakeTimers();
    const request = createRequestFake(json({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", request.request);
    const view = mountForm(
      <SessionsLive
        initialItems={[{ id: "stale", status: "queued" }]}
        initialNextCursor={null}
        listState={listState}
        path="/api/v1/sessions"
        pollMs={10}
      />,
    );
    expect(view.container.textContent).not.toContain("Create your first session");
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(field(view.container, "sessions-empty").textContent).toContain("No sessions yet");
    expect(field(view.container, "sessions-empty-create")).toBeTruthy();
  });

  it("resets server state on a query change and rejects a slow stale poll", async () => {
    vi.useFakeTimers();
    let resolveSlow!: (response: Response) => void;
    const slow = new Promise<Response>((resolve) => {
      resolveSlow = resolve;
    });
    const request = createRequestFake(
      slow,
      json({ items: [{ id: "polled", status: "running" }], nextCursor: null }),
    );
    vi.stubGlobal("fetch", request.request);

    function Harness() {
      const [changed, setChanged] = useState(false);
      const state = changed ? { ...listState, status: "running" } : listState;
      return (
        <>
          <button data-pw="change-query" type="button" onClick={() => setChanged(true)} />
          <SessionsLive
            initialItems={[{ id: changed ? "new-query" : "old-query", status: "queued" }]}
            initialNextCursor={changed ? "new-cursor" : null}
            listState={state}
            path={changed ? "/api/v1/sessions?status=running" : "/api/v1/sessions?limit=50"}
            pollMs={10}
          />
        </>
      );
    }

    const view = mountForm(<Harness />);
    await act(async () => vi.advanceTimersByTimeAsync(10));
    press(field(view.container, "change-query"));
    expect(field(view.container, "session-row-new-query")).toBeTruthy();
    expect(field<HTMLButtonElement>(view.container, "sessions-load-more").textContent).toBe(
      "Load more",
    );
    await act(async () => vi.advanceTimersByTimeAsync(30));
    expect(request.requests.length).toBeGreaterThan(1);
    await act(async () => {
      resolveSlow(json({ items: [{ id: "slow", status: "running" }], nextCursor: null }));
      await slow;
    });
    expect(field(view.container, "session-row-polled")).toBeTruthy();
    expect(view.container.querySelector('[data-pw="session-row-slow"]')).toBeNull();
  });
});
