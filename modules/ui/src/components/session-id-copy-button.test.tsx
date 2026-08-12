// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionIdCopyButton } from "./session-id-copy-button.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<SessionIdCopyButton sessionId="session/one" />));
  return {
    container,
    unmount: () => act(() => root.unmount()),
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("SessionIdCopyButton", () => {
  it("copies the exact session id and announces success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
    const view = mount();
    expect(view.container.querySelector('[role="status"]')).toBeNull();

    await act(async () => {
      (view.container.querySelector("button") as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("session/one");
    expect(view.container.querySelector("button")?.textContent).toBe("Copied");
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe("Session ID copied");
    view.unmount();
  });

  it("announces when clipboard access fails", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    const view = mount();

    await act(async () => {
      (view.container.querySelector("button") as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(view.container.querySelector("button")?.textContent).toBe("Copy failed");
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(
      "Could not copy session ID",
    );
    view.unmount();
  });
});
