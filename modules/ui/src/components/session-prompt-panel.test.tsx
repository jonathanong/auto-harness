// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { argvDisplay, SessionPromptPanel } from "./session-prompt-panel.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("argvDisplay", () => {
  it("elides an appended prompt and keeps other argv intact", () => {
    expect(argvDisplay([], "hi")).toEqual({ tokens: [], appendedPrompt: false, joined: "" });
    expect(argvDisplay(["codex", "exec", "--", "fix it"], "fix it")).toEqual({
      tokens: ["codex", "exec", "--"],
      appendedPrompt: true,
      joined: "codex exec -- fix it",
    });
    expect(argvDisplay(["echo", "hello"], "other")).toEqual({
      tokens: ["echo", "hello"],
      appendedPrompt: false,
      joined: "echo hello",
    });
    expect(argvDisplay(["Ship it"], "Ship it")).toEqual({
      tokens: [],
      appendedPrompt: true,
      joined: "Ship it",
    });
  });
});

describe("SessionPromptPanel", () => {
  it("renders an empty prompt and unassigned argv", () => {
    const html = renderToStaticMarkup(<SessionPromptPanel />);
    expect(html).toContain('data-pw="session-detail-prompt-content" tabindex="0">—</pre>');
    expect(html).toContain("Not assigned yet.");
    expect(html).not.toContain("Copy prompt");
  });

  it("tokenizes argv and replaces an appended prompt with a placeholder", () => {
    const html = renderToStaticMarkup(
      <SessionPromptPanel
        prompt="Ship it"
        resolvedArgv={["codex", "exec", "--json", "--", "Ship it"]}
      />,
    );
    expect(html).toContain("Ship it");
    expect(html).toContain("‹prompt›");
    expect(html).toContain("codex exec --json -- Ship it");
    expect(html).toContain('aria-label="codex exec --json -- ‹prompt›"');
    expect(html).not.toContain('class="sr-only"');
    expect(html).toContain("Copy prompt");
    expect(
      renderToStaticMarkup(<SessionPromptPanel prompt="Ship it" resolvedArgv={["Ship it"]} />),
    ).toContain("‹prompt›");
  });

  it("copies the prompt and announces clipboard failure", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
    const view = mount(<SessionPromptPanel prompt="Ship it" resolvedArgv={["echo"]} />);
    await act(async () => {
      (
        view.container.querySelector('[data-pw="session-detail-copy-prompt"]') as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("Ship it");
    expect(
      view.container.querySelector('[data-pw="session-detail-copy-prompt"]')?.textContent,
    ).toBe("Copied");
    view.unmount();

    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    const failed = mount(<SessionPromptPanel prompt="Ship it" />);
    await act(async () => {
      (
        failed.container.querySelector(
          '[data-pw="session-detail-copy-prompt"]',
        ) as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    expect(
      failed.container.querySelector('[data-pw="session-detail-copy-prompt-status"]')?.textContent,
    ).toBe("Could not copy prompt");
    failed.unmount();
  });
});
