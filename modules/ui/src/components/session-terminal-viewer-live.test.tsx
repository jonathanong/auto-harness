// @vitest-environment happy-dom

import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { field, mount, press, reset as resetHelper } from "./action-form-test-helpers.ts";
import { SessionTerminalViewer } from "./session-terminal-viewer.tsx";
import type { TerminalLogEntry } from "../lib/session-terminal.ts";

const mocks = vi.hoisted(() => ({
  write: vi.fn((_text: string, callback?: () => void) => callback?.()),
  terminalReset: vi.fn(),
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
    reset = mocks.terminalReset;
    refresh() {}
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

describe("SessionTerminalViewer live raw writes", () => {
  it("formats an appended system event for the live terminal", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    let append:
      | ((items: Array<Parameters<typeof SessionTerminalViewer>[0]["items"][number]>) => void)
      | undefined;
    function Lifecycle() {
      const [items, setItems] = useState([
        { timestampSeq: "a", seq: 1, stream: "stdout", content: "output\n", timestamp: "now" },
      ]);
      append = setItems;
      return <SessionTerminalViewer sessionId="lifecycle" items={items} />;
    }
    const view = mount(<Lifecycle />);
    press(field(view.container, "session-log-raw"));
    await settle();
    mocks.write.mockClear();
    act(() =>
      append?.([
        { timestampSeq: "a", seq: 1, stream: "stdout", content: "output\n", timestamp: "now" },
        {
          timestampSeq: "b",
          seq: 2,
          stream: "system",
          content: "Session completed at now",
          timestamp: "now",
        },
      ]),
    );
    expect(mocks.write).toHaveBeenCalledWith(
      "[system] Session completed at now\r\n",
      expect.any(Function),
    );
  });

  it("appends across a sliding log window without resetting terminal history", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    let replaceItems:
      | ((items: Array<Parameters<typeof SessionTerminalViewer>[0]["items"][number]>) => void)
      | undefined;
    function SlidingWindow() {
      const [items, setItems] = useState<TerminalLogEntry[]>([
        { timestampSeq: "a", seq: 1, stream: "stdout", content: "one", timestamp: "now" },
        { timestampSeq: "b", seq: 2, stream: "stdout", content: "two", timestamp: "now" },
      ]);
      replaceItems = setItems;
      return <SessionTerminalViewer sessionId="sliding" items={items} />;
    }

    const view = mount(<SlidingWindow />);
    press(field(view.container, "session-log-raw"));
    await settle();
    mocks.write.mockClear();
    mocks.terminalReset.mockClear();
    act(() =>
      replaceItems?.([
        { timestampSeq: "b", seq: 2, stream: "stdout", content: "two", timestamp: "now" },
        { timestampSeq: "c", seq: 3, stream: "stdout", content: "three", timestamp: "now" },
      ]),
    );

    expect(mocks.terminalReset).not.toHaveBeenCalled();
    expect(mocks.write).toHaveBeenCalledWith("three", expect.any(Function));
  });

  it("resets the terminal when the transcript is replaced", async () => {
    let replaceItems:
      | ((items: Array<Parameters<typeof SessionTerminalViewer>[0]["items"][number]>) => void)
      | undefined;
    function Replace() {
      const [items, setItems] = useState<TerminalLogEntry[]>([
        { timestampSeq: "a", seq: 1, stream: "stdout", content: "one", timestamp: "now" },
      ]);
      replaceItems = setItems;
      return <SessionTerminalViewer sessionId="replace" items={items} />;
    }
    const view = mount(<Replace />);
    press(field(view.container, "session-log-raw"));
    await settle();
    mocks.write.mockClear();
    mocks.terminalReset.mockClear();
    act(() =>
      replaceItems?.([
        { timestampSeq: "z", seq: 9, stream: "stdout", content: "zzz", timestamp: "now" },
      ]),
    );
    expect(mocks.terminalReset).toHaveBeenCalled();
    expect(mocks.write).toHaveBeenCalledWith("zzz", expect.any(Function));
  });
});
