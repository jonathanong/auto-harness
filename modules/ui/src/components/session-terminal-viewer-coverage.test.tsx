// @vitest-environment happy-dom

import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { field, mount, press, reset as resetHelper, setValue } from "./action-form-test-helpers.ts";
import { SessionTerminalViewer } from "./session-terminal-viewer.tsx";
import type { TerminalLogEntry } from "../lib/session-terminal.ts";

const mocks = vi.hoisted(() => ({
  write: vi.fn((_text: string, callback?: () => void) => callback?.()),
  refresh: vi.fn(),
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext() {
      return false;
    }
    findPrevious() {
      return false;
    }
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
    reset() {}
    refresh = mocks.refresh;
    scrollToBottom() {}
    dispose() {}
  },
}));

afterEach(resetHelper);

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SessionTerminalViewer remaining branches", () => {
  it("applies fullscreen layout, shortcuts, and hash misses in readable mode", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    window.location.hash = "#L99";
    HTMLElement.prototype.requestFullscreen = vi.fn(() => Promise.reject(new Error("denied")));
    const view = mount(
      <SessionTerminalViewer
        sessionId="cov"
        items={[
          {
            timestampSeq: "a",
            seq: 1,
            stream: "stdout",
            content: "hello world\n",
            timestamp: "now",
          },
        ]}
      />,
    );
    const terminal = field(view.container, "session-terminal");
    press(field(view.container, "session-terminal-fullscreen"));
    expect(terminal.getAttribute("data-fullscreen")).toBe("true");
    expect(field(view.container, "session-logs").className).toContain("flex-1");
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => document.body,
    });
    document.exitFullscreen = vi.fn(async () => undefined);
    press(field(view.container, "session-terminal-fullscreen"));
    expect(document.exitFullscreen).toHaveBeenCalled();
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => null,
    });
    act(() => document.dispatchEvent(new Event("fullscreenchange")));
    expect(terminal.getAttribute("data-fullscreen")).toBe("false");
    act(() =>
      terminal.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "0" }),
      ),
    );
    act(() =>
      terminal.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "=" }),
      ),
    );
    expect(field(view.container, "session-terminal-font-size").textContent).toBe("14px");
    const search = field<HTMLInputElement>(view.container, "session-terminal-search");
    setValue(search, "   ");
    press(field(view.container, "session-terminal-search-next"));
    expect(field(view.container, "session-terminal-search-result").textContent).toBe("");
    setValue(search, "hello");
    press(field(view.container, "session-terminal-search-next"));
    expect(field(view.container, "session-terminal-search-result").textContent).toBe("1 of 1");
    press(field(view.container, "session-log-raw"));
    press(field(view.container, "session-log-raw"));
    expect(terminal.getAttribute("data-view")).toBe("readable");
    window.location.hash = "";
  });

  it("writes a suffix when the last chunk grows in place", async () => {
    let replaceItems: ((items: TerminalLogEntry[]) => void) | undefined;
    function Grow() {
      const [items, setItems] = useState<TerminalLogEntry[]>([
        { timestampSeq: "a", seq: 1, stream: "stdout", content: "one", timestamp: "now" },
      ]);
      replaceItems = setItems;
      return <SessionTerminalViewer sessionId="grow" items={items} />;
    }
    const view = mount(<Grow />);
    press(field(view.container, "session-log-raw"));
    await settle();
    mocks.write.mockClear();
    act(() =>
      replaceItems?.([
        { timestampSeq: "a", seq: 1, stream: "stdout", content: "oneTWO", timestamp: "now" },
      ]),
    );
    expect(mocks.write).toHaveBeenCalledWith("TWO", expect.any(Function));
  });

  it("appends after an empty raw terminal has no rendered cursor", async () => {
    let replaceItems: ((items: TerminalLogEntry[]) => void) | undefined;
    function EmptyThen() {
      const [items, setItems] = useState<TerminalLogEntry[]>([]);
      replaceItems = setItems;
      return <SessionTerminalViewer sessionId="empty-then" items={items} />;
    }
    const view = mount(<EmptyThen />);
    press(field(view.container, "session-log-raw"));
    await settle();
    mocks.write.mockClear();
    act(() =>
      replaceItems?.([
        { timestampSeq: "a", seq: 1, stream: "stdout", content: "later", timestamp: "now" },
      ]),
    );
    expect(mocks.write).toHaveBeenCalledWith("later", expect.any(Function));
  });

  it("restores raw mode from stored prefs", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key.includes("view") ? "raw" : null),
      setItem: () => undefined,
    });
    const view = mount(<SessionTerminalViewer sessionId="prefs" items={[]} />);
    await settle();
    expect(field(view.container, "session-terminal").getAttribute("data-view")).toBe("raw");
    vi.unstubAllGlobals();
  });

  it("swallows a throwing terminal refresh", async () => {
    mocks.refresh.mockImplementation(() => {
      throw new Error("hidden");
    });
    const view = mount(<SessionTerminalViewer sessionId="refresh" items={[]} />);
    press(field(view.container, "session-log-raw"));
    await settle();
    act(() => document.dispatchEvent(new Event("fullscreenchange")));
  });
});
