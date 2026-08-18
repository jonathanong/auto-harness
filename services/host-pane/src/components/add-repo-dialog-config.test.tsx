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
import { HostConfigForm } from "./host-config-form.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mountedRoots = new Set<() => void>();

const router = {
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

type Reply = Response | Promise<Response>;

function createRequestFake(...replies: Reply[]) {
  const requests: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const queue = [...replies];
  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push([input, init]);
    const reply = queue.shift();
    if (!reply) throw new Error(`unexpected request: ${String(input)}`);
    return reply;
  };
  return { request, requests, enqueue: (...next: Reply[]) => queue.push(...next) };
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

describe("host-pane raw inventory form", () => {
  it("validates JSON before crossing the fetch boundary", () => {
    const { request, requests } = createRequestFake();
    const view = mount(
      withRouter(<HostConfigForm hostId="host/1" initialJson="{}" request={request} />),
    );
    const form = view.container.querySelector("form")!;
    const input = view.container.querySelector(
      '[data-pw="host-config-json"]',
    ) as HTMLTextAreaElement;
    input.value = "not-json";
    act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(view.container.querySelector('[data-pw="host-config-error"]')?.textContent).toBe(
      "Invalid JSON",
    );
    expect(requests).toHaveLength(0);
    input.removeAttribute("name");
    act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(view.container.querySelector('[data-pw="host-config-error"]')?.textContent).toBe(
      "Invalid JSON",
    );
    view.unmount();
  });

  it("shows pending, server errors, and the saved state for valid JSON", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => (resolve = done));
    const { request, requests, enqueue } = createRequestFake(pending);
    const view = mount(
      withRouter(<HostConfigForm hostId="host/1" initialJson="{}" request={request} />),
    );
    const form = view.container.querySelector("form")!;
    const input = view.container.querySelector(
      '[data-pw="host-config-json"]',
    ) as HTMLTextAreaElement;
    const submit = view.container.querySelector(
      '[data-pw="host-config-submit"]',
    ) as HTMLButtonElement;
    input.value = JSON.stringify({ repositories: [] });
    act(() => submit.click());
    await act(async () => new Promise((done) => setTimeout(done, 0)));
    expect(requests).toEqual([
      [
        "/api/v1/hosts/host%2F1/inventory",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ repositories: [] }) }),
      ],
    ]);
    const pendingSubmit = view.container.querySelector(
      '[data-pw="host-config-submit"]',
    ) as HTMLButtonElement;
    expect(pendingSubmit.textContent).toContain("Saving");
    expect(pendingSubmit.disabled).toBe(true);
    await act(async () => {
      resolve(new Response(null, { status: 204 }));
      await Promise.resolve();
    });
    expect(view.container.querySelector('[data-pw="host-config-ok"]')?.textContent).toBe("Saved.");
    expect(router.refresh).toHaveBeenCalledOnce();

    enqueue(new Response("inventory rejected", { status: 409 }));
    act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => Promise.resolve());
    expect(view.container.querySelector('[data-pw="host-config-error"]')?.textContent).toBe(
      "inventory rejected",
    );
    view.unmount();
  });
});
