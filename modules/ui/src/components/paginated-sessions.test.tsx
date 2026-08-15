// @vitest-environment happy-dom

import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PaginatedSessions } from "./paginated-sessions.tsx";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterEach(() => vi.useRealTimers());

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mount(element: React.ReactNode): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

function byPw<T extends Element = HTMLElement>(container: ParentNode, value: string): T {
  const found = container.querySelector<T>(`[data-pw="${value}"]`);
  if (!found) throw new Error(`missing ${value}`);
  return found;
}

describe("PaginatedSessions", () => {
  it("appends cursor pages, keeps the URL filters, and removes duplicate session ids", async () => {
    const fetchPage = vi.fn().mockResolvedValue(
      json({
        items: [
          { id: "first", status: "completed" },
          { id: "second", status: "queued", repositoryId: "repo-1" },
        ],
        nextCursor: null,
      }),
    );
    const view = mount(
      <PaginatedSessions
        initialItems={[{ id: "first", status: "running" }]}
        initialNextCursor="cursor-2"
        path="/api/v1/sessions?limit=1&status=running"
        fetchPage={fetchPage}
        repositoryNames={{ "repo-1": "Harness" }}
        repositoryHrefBase="/repositories"
        hrefBase="/sessions"
      />,
    );
    await act(async () => byPw<HTMLButtonElement>(view.container, "sessions-load-more").click());
    expect(fetchPage).toHaveBeenCalledWith(
      "/api/v1/sessions?limit=1&status=running&cursor=cursor-2",
    );
    expect(view.container.querySelectorAll('[data-pw="session-row-first"]')).toHaveLength(1);
    expect(byPw(view.container, "session-row-second").textContent).toContain("Harness");
    expect(view.container.querySelector('[data-pw="sessions-load-more"]')).toBeNull();
    act(() => view.root.unmount());
  });

  it("disables duplicate loads and exposes a retry without dropping loaded rows", async () => {
    let resolve!: (response: Response) => void;
    const fetchPage = vi
      .fn()
      .mockRejectedValueOnce("offline")
      .mockImplementationOnce(() => new Promise<Response>((done) => (resolve = done)));
    const view = mount(
      <PaginatedSessions
        initialItems={[{ id: "kept", status: "queued" }]}
        initialNextCursor="next"
        path="/api/v1/sessions?limit=1"
        fetchPage={fetchPage}
      />,
    );
    await act(async () => byPw<HTMLButtonElement>(view.container, "sessions-load-more").click());
    expect(byPw(view.container, "sessions-load-more-error").textContent).toContain("offline");
    expect(byPw(view.container, "session-row-kept")).toBeTruthy();
    act(() => byPw<HTMLButtonElement>(view.container, "sessions-load-more-retry").click());
    const pending = byPw<HTMLButtonElement>(view.container, "sessions-load-more");
    expect(pending.disabled).toBe(true);
    expect(pending.textContent).toBe("Loading…");
    act(() => pending.click());
    expect(fetchPage).toHaveBeenCalledTimes(2);
    await act(async () => resolve(json({ items: [{ id: "loaded", status: "failed" }] })));
    expect(byPw(view.container, "session-row-loaded")).toBeTruthy();
    act(() => view.root.unmount());
  });

  it("polls every loaded bound, keeps the appended tail, and recovers from errors", async () => {
    vi.useFakeTimers();
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [{ id: "older", status: "queued" }], nextCursor: null }))
      .mockResolvedValueOnce(
        json({ items: [{ id: "inserted", status: "running" }], nextCursor: "shifted-cursor" }),
      )
      .mockResolvedValueOnce(
        json({ items: [{ id: "new", status: "running" }], nextCursor: "cursor-2" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        json({ items: [{ id: "inserted", status: "completed" }], nextCursor: "shifted-cursor" }),
      )
      .mockResolvedValueOnce(
        json({ items: [{ id: "new", status: "completed" }], nextCursor: "cursor-2" }),
      );
    const view = mount(
      <PaginatedSessions
        initialItems={[{ id: "new", status: "queued" }]}
        initialNextCursor="cursor-2"
        path="/api/v1/sessions?limit=1"
        fetchPage={fetchPage}
        pollMs={10}
      />,
    );
    await act(async () => byPw<HTMLButtonElement>(view.container, "sessions-load-more").click());
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(fetchPage.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/sessions?limit=1&cursor=cursor-2",
      "/api/v1/sessions?limit=1",
      "/api/v1/sessions?limit=1&cursor=shifted-cursor",
    ]);
    expect(byPw(view.container, "session-row-new").textContent).toContain("running");
    expect(byPw(view.container, "session-row-inserted")).toBeTruthy();
    expect(view.container.querySelector('[data-pw="session-row-older"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(byPw(view.container, "sessions-live-error")).toBeTruthy();
    await act(async () => {
      byPw(view.container, "sessions-live-error").querySelector("button")!.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(byPw(view.container, "sessions-live-active")).toBeTruthy();
    expect(fetchPage).toHaveBeenCalledTimes(6);
    expect(byPw(view.container, "session-row-new").textContent).toContain("completed");
    act(() => view.root.unmount());
  });

  it("ignores a slow page from an old query and resets empty/error state", async () => {
    let resolve!: (response: Response) => void;
    const fetchPage = vi.fn(() => new Promise<Response>((done) => (resolve = done)));
    function Harness() {
      const [changed, setChanged] = useState(false);
      return (
        <>
          <button data-pw="change" type="button" onClick={() => setChanged(true)} />
          <PaginatedSessions
            initialItems={changed ? [] : [{ id: "old", status: "queued" }]}
            initialNextCursor={changed ? null : "old-next"}
            initialPollError={changed ? "new error" : null}
            path={changed ? "/api/v1/sessions?status=failed" : "/api/v1/sessions"}
            fetchPage={fetchPage}
            pollMs={10}
            emptyState={<p data-pw="custom-empty">Nothing loaded</p>}
          />
        </>
      );
    }
    const view = mount(<Harness />);
    act(() => byPw<HTMLButtonElement>(view.container, "sessions-load-more").click());
    act(() => byPw<HTMLButtonElement>(view.container, "change").click());
    expect(byPw(view.container, "custom-empty")).toBeTruthy();
    expect(byPw(view.container, "sessions-live-error").textContent).toContain("new error");
    await act(async () => resolve(json({ items: [{ id: "stale", status: "queued" }] })));
    expect(view.container.querySelector('[data-pw="session-row-stale"]')).toBeNull();
    act(() => view.root.unmount());
  });

  it("accepts an API page with omitted optional fields", async () => {
    const fetchPage = vi.fn().mockResolvedValue(json({}));
    const view = mount(
      <PaginatedSessions
        initialItems={[{ id: "kept", status: "queued" }]}
        initialNextCursor="next"
        path="/api/v1/sessions?limit=1"
        fetchPage={fetchPage}
      />,
    );
    await act(async () => byPw<HTMLButtonElement>(view.container, "sessions-load-more").click());
    expect(byPw(view.container, "session-row-kept")).toBeTruthy();
    expect(view.container.querySelector('[data-pw="sessions-load-more"]')).toBeNull();
    act(() => view.root.unmount());
  });
});
