// @vitest-environment happy-dom

import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePaginatedSessions } from "./use-paginated-sessions.ts";
import type { SessionRow } from "./sessions-table.tsx";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

type HookProps = {
  initialItems: SessionRow[];
  initialNextCursor: string | null;
  path: string;
  fetchPage: (path: string) => Promise<Response>;
};

function snapshot(container: HTMLElement) {
  return JSON.parse(container.querySelector('[data-pw="snapshot"]')!.textContent ?? "{}") as {
    ids: string[];
    nextCursor: string | null;
    pollError: string | null;
    loadError: string | null;
  };
}

function Harness(props: HookProps) {
  const api = usePaginatedSessions({ ...props, initialPollError: null });
  return (
    <>
      <button data-pw="load-more" type="button" onClick={() => void api.loadMore()} />
      <button data-pw="retry" type="button" onClick={() => void api.retryRefresh()} />
      <pre data-pw="snapshot">
        {JSON.stringify({
          ids: api.items.map((item) => item.id),
          nextCursor: api.nextCursor,
          pollError: api.pollError,
          loadError: api.loadError,
        })}
      </pre>
    </>
  );
}

function mount(element: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body));
}

describe("usePaginatedSessions stale and empty-cursor guards", () => {
  it("is a no-op when load more has no cursor", async () => {
    const fetchPage = vi.fn();
    const { container, root } = mount(
      <Harness
        initialItems={[{ id: "only", status: "queued" }]}
        initialNextCursor={null}
        path="/api/v1/sessions"
        fetchPage={fetchPage}
      />,
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-pw="load-more"]')!.click(),
    );
    expect(fetchPage).not.toHaveBeenCalled();
    expect(snapshot(container).ids).toEqual(["only"]);
    act(() => root.unmount());
  });

  it("drops a poll failure after the query changes", async () => {
    let rejectPoll!: (reason: unknown) => void;
    const fetchPage = vi.fn(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectPoll = reject;
        }),
    );
    function Query() {
      const [changed, setChanged] = useState(false);
      return (
        <>
          <button data-pw="change" type="button" onClick={() => setChanged(true)} />
          <Harness
            initialItems={[{ id: changed ? "next" : "old", status: "queued" }]}
            initialNextCursor={null}
            path={changed ? "/api/v1/sessions?status=failed" : "/api/v1/sessions"}
            fetchPage={fetchPage}
          />
        </>
      );
    }
    const { container, root } = mount(<Query />);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-pw="retry"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-pw="change"]')!.click());
    await act(async () => rejectPoll("stale-poll"));
    expect(snapshot(container).pollError).toBeNull();
    expect(snapshot(container).ids).toEqual(["next"]);
    act(() => root.unmount());
  });

  it("drops a load-more failure after the query changes", async () => {
    let rejectLoad!: (reason: unknown) => void;
    const fetchPage = vi.fn(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectLoad = reject;
        }),
    );
    function Query() {
      const [changed, setChanged] = useState(false);
      return (
        <>
          <button data-pw="change" type="button" onClick={() => setChanged(true)} />
          <Harness
            initialItems={[{ id: changed ? "next" : "old", status: "queued" }]}
            initialNextCursor={changed ? null : "next"}
            path={changed ? "/api/v1/sessions?status=failed" : "/api/v1/sessions"}
            fetchPage={fetchPage}
          />
        </>
      );
    }
    const { container, root } = mount(<Query />);
    act(() => container.querySelector<HTMLButtonElement>('[data-pw="load-more"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-pw="change"]')!.click());
    await act(async () => rejectLoad("stale-load"));
    expect(snapshot(container).loadError).toBeNull();
    act(() => root.unmount());
  });

  it("ignores a load whose cursor is already present after an overlapping refresh", async () => {
    let resolveLoad!: (response: Response) => void;
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(
        json({ items: [{ id: "second", status: "queued" }], nextCursor: "c2" }),
      )
      .mockImplementationOnce(() => new Promise<Response>((done) => (resolveLoad = done)))
      .mockResolvedValueOnce(
        json({ items: [{ id: "first", status: "running" }], nextCursor: "c2" }),
      )
      .mockResolvedValueOnce(
        json({ items: [{ id: "third", status: "queued" }], nextCursor: null }),
      );
    const { container, root } = mount(
      <Harness
        initialItems={[{ id: "first", status: "queued" }]}
        initialNextCursor="c1"
        path="/api/v1/sessions"
        fetchPage={fetchPage}
      />,
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-pw="load-more"]')!.click(),
    );
    expect(snapshot(container).nextCursor).toBe("c2");
    act(() => container.querySelector<HTMLButtonElement>('[data-pw="load-more"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-pw="retry"]')!.click());
    await act(async () =>
      resolveLoad(json({ items: [{ id: "stale", status: "queued" }], nextCursor: null })),
    );
    expect(snapshot(container).ids).toEqual(["first", "third"]);
    expect(snapshot(container).ids).not.toContain("stale");
    act(() => root.unmount());
  });

  it("ignores a load whose cursor no longer matches the tail after refresh", async () => {
    let resolveLoad!: (response: Response) => void;
    const fetchPage = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((done) => (resolveLoad = done)))
      .mockResolvedValueOnce(
        json({ items: [{ id: "first", status: "running" }], nextCursor: "other" }),
      );
    const { container, root } = mount(
      <Harness
        initialItems={[{ id: "first", status: "queued" }]}
        initialNextCursor="c1"
        path="/api/v1/sessions"
        fetchPage={fetchPage}
      />,
    );
    act(() => container.querySelector<HTMLButtonElement>('[data-pw="load-more"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-pw="retry"]')!.click());
    await act(async () =>
      resolveLoad(json({ items: [{ id: "stale", status: "queued" }], nextCursor: null })),
    );
    expect(snapshot(container).ids).toEqual(["first"]);
    expect(snapshot(container).nextCursor).toBe("other");
    act(() => root.unmount());
  });
});
