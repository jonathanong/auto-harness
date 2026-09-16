// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mount, reset, response, router } from "../../test-helpers/action-form-test-helpers.ts";
import { ResumeButton } from "./resume-button.tsx";

afterEach(reset);

describe("ResumeButton", () => {
  it("surfaces bounded HTTP failures and retries exactly once", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(false, "backend failure ".repeat(40)))
      .mockResolvedValueOnce(response(true));
    const view = mount(<ResumeButton hostId="host-1" pw="host-resume" request={request} />);
    const button = () =>
      view.container.querySelector('[data-pw="host-resume"]') as HTMLButtonElement;

    await act(async () => {
      button().click();
      await Promise.resolve();
    });
    const error = view.container.querySelector('[data-pw="host-resume-error"]');
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.getAttribute("aria-live")).toBe("assertive");
    expect(error?.textContent).toContain("Could not resume host:");
    expect(error?.textContent?.length).toBeLessThanOrEqual(240);
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe("Resume");
    expect(router.refresh).not.toHaveBeenCalled();

    await act(async () => {
      button().click();
      await Promise.resolve();
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(view.container.querySelector('[data-pw="host-resume-error"]')).toBeNull();
    view.unmount();
  });

  it("reports network failures and restores an enabled retry control", async () => {
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    const view = mount(<ResumeButton hostId="host-1" pw="host-resume" request={request} />);

    await act(async () => {
      (view.container.querySelector('[data-pw="host-resume"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(view.container.querySelector('[data-pw="host-resume-error"]')?.textContent).toBe(
      "Could not resume host: offline",
    );
    expect(
      (view.container.querySelector('[data-pw="host-resume"]') as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(router.refresh).not.toHaveBeenCalled();
    view.unmount();
  });

  it("suppresses concurrent duplicate clicks while the request is pending", async () => {
    let release!: (value: ReturnType<typeof response>) => void;
    const request = vi.fn(
      () => new Promise<ReturnType<typeof response>>((done) => (release = done)),
    );
    const view = mount(<ResumeButton hostId="host-1" request={request} />);
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

  it("normalizes primitive and empty thrown failures without a custom selector", async () => {
    for (const [cause, expected] of [
      ["  disconnected  ", "Could not resume host: disconnected"],
      [new Error(""), "Could not resume host. Please try again."],
    ] as const) {
      const view = mount(
        <ResumeButton hostId="host-1" request={vi.fn().mockRejectedValue(cause)} />,
      );
      await act(async () => {
        (view.container.querySelector("button") as HTMLButtonElement).click();
        await Promise.resolve();
      });
      expect(view.container.querySelector('[data-pw="resume-error"]')?.textContent).toBe(expected);
      view.unmount();
    }
  });
});
