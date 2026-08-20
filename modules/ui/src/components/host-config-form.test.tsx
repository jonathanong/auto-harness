// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { mount, reset, router } from "./action-form-test-helpers.ts";
import { HostConfigForm } from "./host-config-form.tsx";

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

afterEach(reset);

describe("HostConfigForm", () => {
  it("validates JSON before crossing the fetch boundary", () => {
    const { request, requests } = createRequestFake();
    const view = mount(
      <HostConfigForm hostId="host/1" initialJson="{}" initialVersion={3} request={request} />,
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

    // Valid JSON that isn't an object (array, string, number, null) can't be merged with the
    // outgoing version field — rejected the same way as unparseable JSON.
    input.value = "[1, 2, 3]";
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

  it("sends the version it was read at, and reports pending/server-error/saved states", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => (resolve = done));
    const { request, requests, enqueue } = createRequestFake(pending);
    const view = mount(
      <HostConfigForm hostId="host/1" initialJson="{}" initialVersion={3} request={request} />,
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
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ repositories: [], version: 3 }),
        }),
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

    enqueue(
      new Response(JSON.stringify({ error: { message: "some other failure" } }), { status: 500 }),
    );
    act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => Promise.resolve());
    expect(view.container.querySelector('[data-pw="host-config-error"]')?.textContent).toBe(
      "some other failure",
    );
    view.unmount();
  });

  it("shows distinct conflict UI on a 409, instead of the generic error text", async () => {
    const { request, enqueue } = createRequestFake(new Response("conflict", { status: 409 }));
    const view = mount(
      <HostConfigForm hostId="host/1" initialJson="{}" initialVersion={3} request={request} />,
    );
    const form = view.container.querySelector("form")!;
    (view.container.querySelector('[data-pw="host-config-json"]') as HTMLTextAreaElement).value =
      JSON.stringify({ repositories: [] });
    act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => Promise.resolve());
    expect(view.container.querySelector('[data-pw="host-config-error"]')).toBeNull();
    expect(view.container.querySelector('[data-pw="host-config-conflict"]')?.textContent).toContain(
      "changed since you loaded this page",
    );

    // Resubmitting after a conflict clears it, same as any other error state.
    enqueue(new Response(null, { status: 204 }));
    act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => Promise.resolve());
    expect(view.container.querySelector('[data-pw="host-config-conflict"]')).toBeNull();
    expect(view.container.querySelector('[data-pw="host-config-ok"]')?.textContent).toBe("Saved.");
    view.unmount();
  });
});
