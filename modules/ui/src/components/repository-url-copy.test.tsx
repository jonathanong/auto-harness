// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RepositoryUrlCopy } from "./repository-url-copy.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => document.body.replaceChildren());

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<RepositoryUrlCopy repositoryId="repo/a" url="https://repo.test/a" />));
  return { container, root };
}

describe("RepositoryUrlCopy", () => {
  it("copies the exact URL and announces success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const view = mount();
    expect(view.container.querySelector('[title="https://repo.test/a"]')?.textContent).toBe(
      "https://repo.test/a",
    );
    await act(async () => {
      (view.container.querySelector("button") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("https://repo.test/a");
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain(
      "Copied Git URL",
    );
    act(() => view.root.unmount());
  });

  it("keeps the URL visible and announces clipboard failures", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    const view = mount();
    await act(async () => {
      (view.container.querySelector("button") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(view.container.querySelector("button")?.textContent).toBe("Copy failed");
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain(
      "Could not copy",
    );
    act(() => view.root.unmount());
  });
});
