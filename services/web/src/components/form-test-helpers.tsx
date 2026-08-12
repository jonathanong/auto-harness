import { createRoot } from "react-dom/client";
import React, { act } from "react";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { TooltipProvider } from "@auto-harness/ui";
import { afterEach, vi } from "vitest";

const router = {
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
} satisfies AppRouterInstance;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export { router };

export function mountForm(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <AppRouterContext.Provider value={router}>
        <TooltipProvider delayDuration={0}>{node}</TooltipProvider>
      </AppRouterContext.Provider>,
    ),
  );
  return { container, unmount: () => act(() => root.unmount()) };
}

export function field<T extends HTMLElement>(container: Element, pw: string): T {
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

export function createApiFake(...replies: ApiReply[]) {
  const requests: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const queue = [...replies];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push([input, init]);
    const reply = queue.shift();
    if (!reply) throw new Error(`unexpected request: ${String(input)}`);
    return typeof reply === "function" ? reply() : reply;
  };
  vi.stubGlobal("fetch", fetch);
  return { requests, enqueue: (...next: ApiReply[]) => queue.push(...next) };
}

export function submit(form: HTMLFormElement) {
  act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

export function press(element: HTMLElement) {
  act(() => element.click());
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  document.body.replaceChildren();
  router.back.mockReset();
  router.forward.mockReset();
  router.prefetch.mockReset();
  router.push.mockReset();
  router.refresh.mockReset();
  router.replace.mockReset();
  vi.unstubAllGlobals();
});
