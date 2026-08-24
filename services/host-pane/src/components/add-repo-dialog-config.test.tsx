// @vitest-environment happy-dom

import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@auto-harness/ui";
import { AddRepoDialog } from "./add-repo-dialog.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mountedRoots = new Set<() => void>();

const router = {
  bfcacheId: "test",
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
} satisfies AppRouterInstance;

function withRouter(node: React.ReactNode) {
  return (
    <AppRouterContext.Provider value={router}>
      <TooltipProvider>{node}</TooltipProvider>
    </AppRouterContext.Provider>
  );
}

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  const unmount = () => {
    if (!mountedRoots.delete(unmount)) return;
    act(() => root.unmount());
  };
  mountedRoots.add(unmount);
  return { container, unmount };
}

afterEach(() => {
  for (const unmount of mountedRoots) unmount();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("host-pane repository dialog", () => {
  it("opens the real dialog and renders the local attachment form", () => {
    const view = mount(
      withRouter(<AddRepoDialog hostId="host-1" catalog={[{ id: "repo-1", name: "Harness" }]} />),
    );
    const open = view.container.querySelector('[data-pw="add-repo-open"]') as HTMLButtonElement;
    expect(open).not.toBeNull();
    expect(document.body.querySelector('[data-pw="add-repo-dialog"]')).toBeNull();
    act(() => open.click());
    const dialog = document.body.querySelector('[data-pw="add-repo-dialog"]');
    expect(dialog?.textContent).toContain("Attaches an existing catalog repository");
    expect(dialog?.querySelector('[data-pw="form-add-local-repo"]')).not.toBeNull();
    expect(dialog?.querySelector('[data-pw="add-repo-catalog-id"]')).not.toBeNull();
    const close = dialog?.querySelector('[data-pw="dialog-close"]');
    expect(close).not.toBeNull();
    act(() => (close as HTMLButtonElement).click());
    expect(document.body.querySelector('[data-pw="add-repo-dialog"]')).toBeNull();
    view.unmount();
  });
});
