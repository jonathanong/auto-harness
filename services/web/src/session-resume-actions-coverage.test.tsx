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

function response(body: string, ok = true) {
  return { ok, text: vi.fn(async () => body), json: vi.fn(async () => JSON.parse(body)) };
}

function setInput(pw: string, value: string) {
  const input = document.body.querySelector(`[data-pw="${pw}"]`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  act(() => input.dispatchEvent(new Event("input", { bubbles: true })));
}

async function submitResume(container: HTMLElement) {
  await act(async () => {
    (container.querySelector('[data-pw="session-resume"]') as HTMLButtonElement).click();
  });
  await act(async () => {
    (document.body.querySelector('[data-pw="session-resume-submit"]') as HTMLButtonElement).click();
    await Promise.resolve();
  });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("session resume actions", () => {
  it("pushes the resumed session and refreshes when the response has no id", async () => {
    const router = { push: vi.fn(), refresh: vi.fn() };
    const fetchMock = vi.fn().mockResolvedValue(response(JSON.stringify({ id: "new/session" })));
    vi.stubGlobal("fetch", fetchMock);
    const view = mount(
      <SessionActions sessionId="old" status="completed" detailHrefBase="/runs" />,
      router,
    );
    const resume = view.container.querySelector('[data-pw="session-resume"]') as HTMLButtonElement;
    expect(resume.textContent).toBe("Resume");
    expect(resume.getAttribute("aria-busy")).toBe("false");
    await submitResume(view.container);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/sessions/old/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(router.push).toHaveBeenCalledWith("/runs/new%2Fsession");
    expect(router.refresh).not.toHaveBeenCalled();
    view.unmount();

    const noIdRouter = { push: vi.fn(), refresh: vi.fn() };
    const noIdFetch = vi.fn().mockResolvedValue(response(JSON.stringify({})));
    vi.stubGlobal("fetch", noIdFetch);
    const noIdView = mount(<SessionActions sessionId="old" status="completed" />, noIdRouter);
    await submitResume(noIdView.container);
    expect(noIdFetch).toHaveBeenCalledOnce();
    expect(noIdRouter.refresh).toHaveBeenCalledOnce();
    noIdView.unmount();
  });

  it("submits trimmed optional overrides and disables actions while pending", async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<ReturnType<typeof response>>((done) => (resolve = done))),
    );
    const router = { push: vi.fn(), refresh: vi.fn() };
    const view = mount(<SessionActions sessionId="old" status="failed" />, router);
    act(() =>
      (view.container.querySelector('[data-pw="session-resume"]') as HTMLButtonElement).click(),
    );
    setInput("session-resume-prompt", "  continue carefully  ");
    setInput("session-resume-timeout", "900");
    setInput("session-resume-priority", "75");
    await act(async () => {
      (
        document.body.querySelector('[data-pw="session-resume-submit"]') as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledWith("/api/v1/sessions/old/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "continue carefully", timeout: 900, priority: 75 }),
    });
    const pendingResume = view.container.querySelector(
      '[data-pw="session-resume"]',
    ) as HTMLButtonElement;
    expect(pendingResume.disabled).toBe(true);
    expect(pendingResume.textContent).toBe("Resuming…");
    expect(pendingResume.getAttribute("aria-busy")).toBe("true");
    expect(
      (view.container.querySelector('[data-pw="session-clone"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    resolve(response(JSON.stringify({ id: "continued" })));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(router.push).toHaveBeenCalledWith("/sessions/continued");
    view.unmount();
  });

  it("keeps a failed resume open and surfaces its error inside the dialog", async () => {
    const router = { push: vi.fn(), refresh: vi.fn() };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response("cannot resume this session", false)),
    );
    const view = mount(<SessionActions sessionId="old" status="failed" />, router);
    await submitResume(view.container);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const dialog = document.body.querySelector('[data-pw="session-resume-dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    const error = dialog.querySelector('[data-pw="session-resume-error"]');
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toBe("cannot resume this session");
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    view.unmount();
  });
});
