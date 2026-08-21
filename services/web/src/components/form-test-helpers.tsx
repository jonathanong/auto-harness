import { createRoot } from "react-dom/client";
import React, { act } from "react";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { Toast, TooltipProvider, dismissToast } from "@auto-harness/ui";
import { afterEach, vi } from "vitest";

const router = {
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
} satisfies AppRouterInstance;
const mountedRoots = new Set<() => void>();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export { router };

export function mountForm(
  node: React.ReactNode,
  {
    pathname = "/",
    searchParams = new URLSearchParams(),
  }: { pathname?: string | null; searchParams?: URLSearchParams } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <AppRouterContext.Provider value={router}>
        <PathnameContext.Provider value={pathname}>
          <SearchParamsContext.Provider value={searchParams}>
            <TooltipProvider delayDuration={0}>
              <React.Suspense fallback={null}>
                <Toast />
              </React.Suspense>
              {node}
            </TooltipProvider>
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </AppRouterContext.Provider>,
    ),
  );
  const unmount = () => {
    if (!mountedRoots.delete(unmount)) return;
    act(() => root.unmount());
  };
  mountedRoots.add(unmount);
  return { container, unmount };
}

// ParentNode (not Element) so callers can pass `document` itself, not just an element —
// both implement querySelector via the same mixin interface.
export function field<T extends HTMLElement>(container: ParentNode, pw: string): T {
  const element = container.querySelector(`[data-pw="${pw}"]`);
  if (!element) throw new Error(`missing ${pw}`);
  return element as T;
}

export function setValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
    if (!descriptor?.set) throw new Error("missing native value setter");
    descriptor.set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

type ApiReply = Response | Promise<Response> | (() => Response | Promise<Response>);

export function createRequestFake(...replies: ApiReply[]) {
  const requests: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const queue = [...replies];
  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push([input, init]);
    const reply = queue.shift();
    if (!reply) throw new Error(`unexpected request: ${String(input)}`);
    return typeof reply === "function" ? reply() : reply;
  };
  return { request, requests, enqueue: (...next: ApiReply[]) => queue.push(...next) };
}

export function createApiFake(...replies: ApiReply[]) {
  const fake = createRequestFake(...replies);
  vi.stubGlobal("fetch", fake.request);
  return fake;
}

export function submit(form: HTMLFormElement) {
  act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
export function press(element: HTMLElement) {
  act(() => element.click());
}

export function pressCancel(root: ParentNode = document) {
  const cancel = [...root.querySelectorAll("button")].find(
    (button) => button.textContent === "Cancel",
  );
  if (!cancel) throw new Error("missing Cancel");
  press(cancel);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
afterEach(() => {
  for (const unmount of mountedRoots) unmount();
  dismissToast();
  document.body.replaceChildren();
  router.back.mockReset();
  router.forward.mockReset();
  router.prefetch.mockReset();
  router.push.mockReset();
  router.refresh.mockReset();
  router.replace.mockReset();
  vi.unstubAllGlobals();
});
