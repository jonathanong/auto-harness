// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PaginatedSessions } from "./paginated-sessions.tsx";
import { dedupeSessions, pagePath } from "./use-paginated-sessions.ts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterEach(() => vi.useRealTimers());

describe("usePaginatedSessions", () => {
  it("serializes polling and load-more requests", async () => {
    vi.useFakeTimers();
    let resolvePoll!: (response: Response) => void;
    let resolveLoad!: (response: Response) => void;
    const fetchPage = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((done) => (resolvePoll = done)))
      .mockImplementationOnce(() => new Promise<Response>((done) => (resolveLoad = done)));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <PaginatedSessions
          initialItems={[{ id: "first", status: "queued" }]}
          initialNextCursor="old-cursor"
          path="/api/v1/sessions?limit=1"
          fetchPage={fetchPage}
          pollMs={10}
        />,
      ),
    );

    await act(async () => vi.advanceTimersByTimeAsync(10));
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-pw="sessions-load-more"]')!.click(),
    );
    expect(fetchPage).toHaveBeenCalledTimes(1);
    await act(async () =>
      resolvePoll(
        new Response(
          JSON.stringify({
            items: [{ id: "first", status: "running" }],
            nextCursor: "new-cursor",
          }),
        ),
      ),
    );

    act(() =>
      container.querySelector<HTMLButtonElement>('[data-pw="sessions-load-more"]')!.click(),
    );
    expect(fetchPage).toHaveBeenLastCalledWith("/api/v1/sessions?limit=1&cursor=new-cursor");
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(fetchPage).toHaveBeenCalledTimes(2);
    await act(async () =>
      resolveLoad(
        new Response(
          JSON.stringify({ items: [{ id: "second", status: "queued" }], nextCursor: null }),
        ),
      ),
    );
    expect(container.querySelector('[data-pw="session-row-second"]')).toBeTruthy();
    act(() => root.unmount());
  });

  it("supports cursor helpers and stable first-occurrence deduplication", () => {
    expect(pagePath("/api/v1/sessions?cursor=old&status=queued", "next value")).toBe(
      "/api/v1/sessions?cursor=next+value&status=queued",
    );
    expect(pagePath("/api/v1/sessions?cursor=old", "")).toBe("/api/v1/sessions");
    expect(
      dedupeSessions([
        { id: "one", status: "running" },
        { id: "one", status: "completed" },
        { id: "two", status: "queued" },
      ]),
    ).toEqual([
      { id: "one", status: "running" },
      { id: "two", status: "queued" },
    ]);
  });
});
