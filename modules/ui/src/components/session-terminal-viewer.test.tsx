// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { field, mount, press, reset as resetHelper, setValue } from "./action-form-test-helpers.ts";
import { SessionTerminalViewer } from "./session-terminal-viewer.tsx";

const mocks = vi.hoisted(() => ({
  findNext: vi.fn(() => true),
  findPrevious: vi.fn(() => false),
  write: vi.fn((_text: string, callback?: () => void) => callback?.()),
  terminalReset: vi.fn(),
  scrollToBottom: vi.fn(),
  dispose: vi.fn(),
  refresh: vi.fn(),
  terminalOptions: vi.fn(),
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext = mocks.findNext;
    findPrevious = mocks.findPrevious;
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    rows = 40;
    options: { fontSize?: number } = {};
    buffer = { active: { viewportY: 0, baseY: 0 } };
    loadAddon() {}
    open() {}
    write = mocks.write;
    reset = mocks.terminalReset;
    refresh = mocks.refresh;
    scrollToBottom = mocks.scrollToBottom;
    dispose = mocks.dispose;
    constructor(options: unknown) {
      mocks.terminalOptions(options);
    }
  },
}));

afterEach(resetHelper);

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function openRaw(container: HTMLElement): Promise<void> {
  await settle();
  if (field(container, "session-terminal").getAttribute("data-view") !== "raw") {
    press(field(container, "session-log-raw"));
    await settle();
  }
  expect(mocks.terminalOptions).toHaveBeenCalled();
}

describe("SessionTerminalViewer raw terminal", () => {
  it("keeps the 120x40 PTY grid and drives search, font, fullscreen, and download", async () => {
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

    const view = mount(
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
    await openRaw(view.container);
    expect(field(view.container, "session-terminal").getAttribute("data-view")).toBe("raw");
    expect(mocks.write).toHaveBeenCalledWith("\u001b[32mhello\u001b[0m\n", expect.any(Function));
    expect(mocks.terminalOptions).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 120, rows: 40 }),
    );

    const search = field<HTMLInputElement>(view.container, "session-terminal-search");
    setValue(search, "hello");
    press(field(view.container, "session-terminal-search-next"));
    expect(mocks.findNext).toHaveBeenCalledWith("hello", { caseSensitive: false });
    expect(field(view.container, "session-terminal-search-result").textContent).toBe("Match found");
    press(field(view.container, "session-terminal-search-previous"));
    expect(field(view.container, "session-terminal-search-result").textContent).toBe("No match");

    press(field(view.container, "session-terminal-font-increase"));
    expect(field(view.container, "session-terminal-font-size").textContent).toBe("14px");
    const terminal = field(view.container, "session-terminal");
    act(() =>
      terminal.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "-" }),
      ),
    );
    expect(field(view.container, "session-terminal-font-size").textContent).toBe("13px");
    act(() =>
      terminal.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "f" }),
      ),
    );
    expect(document.activeElement).toBe(search);
    press(field(view.container, "session-terminal-fullscreen"));
    expect(field(view.container, "session-terminal").getAttribute("data-fullscreen")).toBe("true");
    press(field(view.container, "session-terminal-fullscreen"));
    expect(field(view.container, "session-terminal").getAttribute("data-fullscreen")).toBe("false");
    expect((field(view.container, "session-log-pretty") as HTMLButtonElement).disabled).toBe(true);
    press(field(view.container, "session-terminal-download"));
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:log");
    click.mockRestore();
  });

  it("constructs at the current font size after raw mode is enabled", async () => {
    const view = mount(<SessionTerminalViewer sessionId="racy" items={[]} />);
    press(field(view.container, "session-terminal-font-increase"));
    await openRaw(view.container);
    expect(mocks.terminalOptions).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 14 }));
  });
});
