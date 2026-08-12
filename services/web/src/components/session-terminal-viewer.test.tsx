// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, press, setValue } from "./form-test-helpers.tsx";
import { SessionTerminalViewer } from "./session-terminal-viewer.tsx";

const mocks = vi.hoisted(() => ({
  fit: vi.fn(),
  findNext: vi.fn(() => true),
  findPrevious: vi.fn(() => false),
  write: vi.fn((_text: string, callback?: () => void) => callback?.()),
  reset: vi.fn(),
  scrollToBottom: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = mocks.fit;
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext = mocks.findNext;
    findPrevious = mocks.findPrevious;
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: { fontSize?: number } = {};
    buffer = { active: { viewportY: 0, baseY: 0 } };
    loadAddon() {}
    open() {}
    write = mocks.write;
    reset = mocks.reset;
    scrollToBottom = mocks.scrollToBottom;
    dispose = mocks.dispose;
  },
}));

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SessionTerminalViewer", () => {
  it("renders accessible controls and drives search, font, fullscreen, and download", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const createObjectURL = vi.fn(() => "blob:log");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const view = mountForm(
      <SessionTerminalViewer
        sessionId="session/1"
        items={[
          {
            timestampSeq: "a",
            seq: 1,
            stream: "stdout",
            content: "\u001b[32mhello\u001b[0m\n",
            timestamp: "now",
          },
        ]}
      />,
    );
    await settle();
    expect(field(view.container, "session-terminal").getAttribute("aria-label")).toContain(
      "terminal",
    );
    expect(mocks.write).toHaveBeenCalledWith("\u001b[32mhello\u001b[0m\n", expect.any(Function));

    const search = field<HTMLInputElement>(view.container, "session-terminal-search");
    setValue(search, "hello");
    press(field(view.container, "session-terminal-search-next"));
    expect(mocks.findNext).toHaveBeenCalledWith("hello", { caseSensitive: false });
    expect(field(view.container, "session-terminal-search-result").textContent).toBe("Match found");
    press(field(view.container, "session-terminal-search-previous"));
    expect(field(view.container, "session-terminal-search-result").textContent).toBe("No match");

    press(field(view.container, "session-terminal-font-increase"));
    expect(field(view.container, "session-terminal-font-size").textContent).toBe("14px");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, key: "-" })));
    expect(field(view.container, "session-terminal-font-size").textContent).toBe("13px");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, key: "f" })));
    expect(document.activeElement).toBe(search);

    press(field(view.container, "session-terminal-fullscreen"));
    expect(field(view.container, "session-terminal").getAttribute("data-fullscreen")).toBe("true");
    press(field(view.container, "session-terminal-fullscreen"));
    expect(field(view.container, "session-terminal").getAttribute("data-fullscreen")).toBe("false");
    press(field(view.container, "session-terminal-download"));
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:log");
    click.mockRestore();
  });

  it("keeps the documented empty state", () => {
    const view = mountForm(<SessionTerminalViewer sessionId="empty" items={[]} />);
    expect(field(view.container, "session-logs-empty").textContent).toContain("No logs");
  });
});
