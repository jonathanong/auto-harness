import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { vi } from "vitest";
import { type HostInventory, type HostRepository } from "@auto-harness/shared";

import { TooltipProvider } from "./tooltip.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mountedRoots = new Set<() => void>();
export const router = {
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
} satisfies AppRouterInstance;
export const inventory: HostInventory = {
  repositories: [],
  providerAccounts: [],
  commandProfiles: {},
  capabilities: [],
};
export const repo: HostRepository = {
  id: "repo-1",
  path: "/src/repo",
  defaultBranch: "main",
  worktrees: [],
};

export function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(
        AppRouterContext.Provider,
        { value: router },
        createElement(TooltipProvider, null, node),
      ),
    ),
  );
  const unmount = () => {
    if (!mountedRoots.delete(unmount)) return;
    act(() => root.unmount());
  };
  mountedRoots.add(unmount);
  return { container, unmount };
}

export function response(ok: boolean, body: unknown = "write failed") {
  return { ok, json: async () => body, text: async () => String(body) };
}

export function input(element: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

export function reset() {
  for (const unmount of mountedRoots) unmount();
  document.body.replaceChildren();
  router.refresh.mockReset();
  router.push.mockReset();
  vi.restoreAllMocks();
}
