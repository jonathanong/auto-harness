// @vitest-environment happy-dom

import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { field, mount, reset } from "../../test-helpers/action-form-test-helpers.ts";
import { openRawTerminal } from "../../test-helpers/session-terminal-raw-test-helpers.ts";
import { SessionTerminalViewer } from "./session-terminal-viewer.tsx";
import type { TerminalLogEntry } from "../lib/session-terminal.ts";

const mocks = vi.hoisted(() => ({
  write: vi.fn((_text: string, callback?: () => void) => callback?.()),
  scrollToBottom: vi.fn(),
  reset: vi.fn(),
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
    buffer = { active: { viewportY: 0, baseY: 10 } };
    loadAddon() {}
    open() {}
    write = mocks.write;
    reset = mocks.reset;
    refresh() {}
    scrollToBottom = mocks.scrollToBottom;
    dispose() {}
  },
}));

afterEach(reset);

const first: TerminalLogEntry = {
  timestampSeq: "a",
  seq: 1,
  stream: "stdout",
  content: "one",
  timestamp: "now",
};

describe("SessionTerminalViewer follow mode", () => {
  it("appends a new chunk without scrolling when the viewport is above the bottom", async () => {
    let replaceItems: ((items: TerminalLogEntry[]) => void) | undefined;
    function Grow() {
      const [items, setItems] = useState<TerminalLogEntry[]>([first]);
      replaceItems = setItems;
      return <SessionTerminalViewer sessionId="follow" items={items} />;
    }
    const view = mount(<Grow />);
    await openRawTerminal(view.container);
    mocks.write.mockClear();
    mocks.scrollToBottom.mockClear();
    act(() =>
      replaceItems?.([
        first,
        { timestampSeq: "b", seq: 2, stream: "stdout", content: "two", timestamp: "now" },
      ]),
    );
    expect(mocks.write).toHaveBeenCalledWith("two", expect.any(Function));
    expect(mocks.scrollToBottom).not.toHaveBeenCalled();
    expect(field(view.container, "session-terminal")).toBeTruthy();
  });

  it("resets the terminal when history is replaced rather than appended", async () => {
    let replaceItems: ((items: TerminalLogEntry[]) => void) | undefined;
    function Replace() {
      const [items, setItems] = useState<TerminalLogEntry[]>([first]);
      replaceItems = setItems;
      return <SessionTerminalViewer sessionId="reset" items={items} />;
    }
    const view = mount(<Replace />);
    await openRawTerminal(view.container);
    mocks.reset.mockClear();
    mocks.scrollToBottom.mockClear();
    act(() =>
      replaceItems?.([
        { timestampSeq: "z", seq: 9, stream: "stdout", content: "other", timestamp: "now" },
      ]),
    );
    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(mocks.write).toHaveBeenCalledWith("other", expect.any(Function));
    expect(mocks.scrollToBottom).not.toHaveBeenCalled();
  });
});
