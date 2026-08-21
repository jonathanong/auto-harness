// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mount, reset, response, router } from "./action-form-test-helpers.ts";
import { DrainButton } from "./drain-button.tsx";

afterEach(reset);

describe("DrainButton", () => {
  it("surfaces bounded HTTP failures and retries exactly once", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(false, "backend failure ".repeat(40)))
      .mockResolvedValueOnce(response(true));
    const view = mount(<DrainButton hostId="host-1" pw="host-drain" request={request} />);
    const button = () =>
      view.container.querySelector('[data-pw="host-drain"]') as HTMLButtonElement;

    await act(async () => {
      button().click();
      await Promise.resolve();
    });
    const error = view.container.querySelector('[data-pw="host-drain-error"]');
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.getAttribute("aria-live")).toBe("assertive");
    expect(error?.textContent).toContain("Could not drain host:");
    expect(error?.textContent?.length).toBeLessThanOrEqual(240);
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe("Drain");
    expect(router.refresh).not.toHaveBeenCalled();

    await act(async () => {
      button().click();
      await Promise.resolve();
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(view.container.querySelector('[data-pw="host-drain-error"]')).toBeNull();
    view.unmount();
  });

  it("reports network failures and restores an enabled retry control", async () => {
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    const view = mount(<DrainButton hostId="host-1" pw="host-drain" request={request} />);

    await act(async () => {
      (view.container.querySelector('[data-pw="host-drain"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(view.container.querySelector('[data-pw="host-drain-error"]')?.textContent).toBe(
      "Could not drain host: offline",
    );
    expect(
      (view.container.querySelector('[data-pw="host-drain"]') as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(router.refresh).not.toHaveBeenCalled();
    view.unmount();
  });

  it("suppresses concurrent duplicate clicks while the request is pending", async () => {
    let release!: (value: ReturnType<typeof response>) => void;
    const request = vi.fn(
      () => new Promise<ReturnType<typeof response>>((done) => (release = done)),
    );
    const view = mount(<DrainButton hostId="host-1" request={request} />);
    const button = () => view.container.querySelector("button") as HTMLButtonElement;

    await act(async () => {
      button().click();
      button().click();
      await Promise.resolve();
    });
    expect(request).toHaveBeenCalledOnce();
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");

    release(response(true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(button().disabled).toBe(false);
    expect(router.refresh).toHaveBeenCalledOnce();
    view.unmount();
  });
});
