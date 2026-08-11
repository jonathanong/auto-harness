// @vitest-environment happy-dom

import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import * as React from "react";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionActions, TooltipProvider } from "@auto-harness/ui";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Router = { push: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> };

function mount(node: ReactNode, router: Router) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        AppRouterContext.Provider,
        { value: router as never },
        createElement(TooltipProvider, null, node),
      ),
    );
  });
  return { container, unmount: () => act(() => root.unmount()) };
}

function response(ok: boolean, body = "") {
  return { ok, text: vi.fn(async () => body), json: vi.fn(async () => JSON.parse(body)) };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("SessionActions", () => {
  it("renders status-specific controls and refreshes after cancel and archive", async () => {
    const router = { push: vi.fn(), refresh: vi.fn() };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response(true));
    vi.stubGlobal("fetch", fetchMock);
    const view = mount(<SessionActions sessionId="a/b" status="running" />, router);

    expect(view.container.querySelector('[data-pw="session-cancel"]')).not.toBeNull();
    expect(view.container.querySelector('[data-pw="session-resume"]')).toBeNull();
    await act(async () => {
      (view.container.querySelector('[data-pw="session-cancel"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/sessions/a%2Fb/cancel", {
      method: "POST",
    });
    expect(router.refresh).toHaveBeenCalledOnce();

    await act(async () => {
      (view.container.querySelector('[data-pw="session-archive"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/sessions/a%2Fb/archive", {
      method: "POST",
    });
    expect(router.refresh).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("shows a pending action and displays failed responses", async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    const fetchMock = vi.fn(
      () => new Promise<ReturnType<typeof response>>((done) => (resolve = done)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const router = { push: vi.fn(), refresh: vi.fn() };
    const view = mount(<SessionActions sessionId="sess" status="queued" />, router);
    const cancel = view.container.querySelector('[data-pw="session-cancel"]') as HTMLButtonElement;
    act(() => cancel.click());
    const pendingCancel = view.container.querySelector(
      '[data-pw="session-cancel"]',
    ) as HTMLButtonElement;
    expect(pendingCancel.disabled).toBe(true);
    expect(pendingCancel.textContent).toBe("…");
    resolve(response(false, "cannot cancel"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.container.querySelector('[data-pw="session-action-error"]')?.textContent).toBe(
      "cannot cancel",
    );
    expect(router.refresh).not.toHaveBeenCalled();
    view.unmount();
  });

  it("pushes the resumed session and refreshes when the response has no id", async () => {
    const router = { push: vi.fn(), refresh: vi.fn() };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response(true, JSON.stringify({ id: "new/session" })));
    vi.stubGlobal("fetch", fetchMock);
    const view = mount(
      <SessionActions sessionId="old" status="completed" detailHrefBase="/runs" />,
      router,
    );
    const resume = view.container.querySelector('[data-pw="session-resume"]') as HTMLButtonElement;
    expect(resume).not.toBeNull();
    await act(async () => {
      (view.container.querySelector('[data-pw="session-resume"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(router.push).toHaveBeenCalledWith("/runs/new%2Fsession");
    expect(router.refresh).not.toHaveBeenCalled();

    view.unmount();
    const noIdRouter = { push: vi.fn(), refresh: vi.fn() };
    const noIdFetch = vi.fn().mockResolvedValue(response(true, JSON.stringify({})));
    vi.stubGlobal("fetch", noIdFetch);
    const noIdView = mount(
      <SessionActions sessionId="old" status="completed" detailHrefBase="/runs" />,
      noIdRouter,
    );
    await act(async () => {
      (noIdView.container.querySelector('[data-pw="session-resume"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(noIdFetch).toHaveBeenCalledOnce();
    expect(noIdRouter.refresh).toHaveBeenCalledOnce();
    noIdView.unmount();
  });

  it("omits cancel and resume for unrelated statuses", () => {
    const router = { push: vi.fn(), refresh: vi.fn() };
    const view = mount(<SessionActions sessionId="sess" status="unknown" />, router);
    expect(view.container.querySelector('[data-pw="session-cancel"]')).toBeNull();
    expect(view.container.querySelector('[data-pw="session-resume"]')).toBeNull();
    expect(view.container.querySelector('[data-pw="session-archive"]')).not.toBeNull();
    view.unmount();
  });
});
