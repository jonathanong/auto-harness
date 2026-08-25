import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, vi } from "vitest";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { TooltipProvider } from "@auto-harness/ui";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function stubApi(routes: Record<string, unknown | Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://control.test");
    const route = routes[`${url.pathname}${url.search}`];
    if (route === "__throw_string__") throw "offline";
    if (route instanceof Error) throw route;
    if (route instanceof Response) return route;
    if (route === undefined) return jsonResponse({ error: "missing test route" }, 404);
    return jsonResponse(route);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

export async function renderPage(node: Promise<React.ReactNode> | React.ReactNode) {
  const router = {
    bfcacheId: "test",
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  } satisfies AppRouterInstance;
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <TooltipProvider delayDuration={0}>{await node}</TooltipProvider>
    </AppRouterContext.Provider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});
