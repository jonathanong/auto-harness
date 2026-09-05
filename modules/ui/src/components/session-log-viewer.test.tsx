// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { field, mount, press, reset, setValue } from "./action-form-test-helpers.ts";
import { SessionTerminalViewer } from "./session-terminal-viewer.tsx";
import type { TerminalLogEntry } from "../lib/session-terminal.ts";

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class SearchAddon {
    findNext() {
      return false;
    }
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class Terminal {
    loadAddon() {}
    open() {}
    write() {}
    dispose() {}
  },
}));

afterEach(reset);

function entry(content: string, seq: number, stream = "stdout"): TerminalLogEntry {
  return {
    timestampSeq: String(seq),
    seq,
    stream,
    content: content.endsWith("\n") ? content : `${content}\n`,
    timestamp: "now",
  };
}

describe("readable session logs", () => {
  it("wraps JSONL with line numbers, pretty JSON, filters, and search", () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const view = mount(
      <SessionTerminalViewer
        sessionId="s1"
        items={[
          entry("\u001b[32mhello\u001b[0m", 1),
          entry(
            JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }),
            2,
          ),
          entry(
            JSON.stringify({
              type: "item.started",
              item: { type: "command_execution", command: "ls" },
            }),
            3,
          ),
        ]}
      />,
    );
    expect(field(view.container, "session-terminal").getAttribute("data-view")).toBe("readable");
    expect(field(view.container, "session-log-line-1").textContent).toContain("hello");
    expect(field(view.container, "session-log-line-2").textContent).toContain(
      '"type": "item.completed"',
    );
    expect(field(view.container, "session-logs").className).toContain("w-full");
    press(field(view.container, "session-log-pretty"));
    expect(field(view.container, "session-log-line-2").textContent).toContain("hi");
    press(field(view.container, "session-log-filter-tool"));
    expect(view.container.querySelector('[data-pw="session-log-line-3"]')).not.toBeNull();
    expect(view.container.querySelector('[data-pw="session-log-line-2"]')).toBeNull();
    press(field(view.container, "session-log-filter-tool"));
    press(field(view.container, "session-log-filter-all"));
    press(field(view.container, "session-log-line-link-2"));
    expect(writeText).toHaveBeenCalled();
    expect(field(view.container, "session-log-line-2").getAttribute("data-highlighted")).toBe(
      "true",
    );
    const search = field<HTMLInputElement>(view.container, "session-terminal-search");
    setValue(search, "hello");
    press(field(view.container, "session-terminal-search-next"));
    expect(field(view.container, "session-terminal-search-result").textContent).toBe("1 of 1");
    press(field(view.container, "session-terminal-search-previous"));
    setValue(search, "missing");
    press(field(view.container, "session-terminal-search-next"));
    expect(field(view.container, "session-terminal-search-result").textContent).toBe("No match");
  });

  it("expands collapsed JSON and keeps the empty state", () => {
    const huge = JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "x", aggregated_output: "z".repeat(600) },
    });
    const view = mount(<SessionTerminalViewer sessionId="s2" items={[entry(huge, 1)]} />);
    expect(field(view.container, "session-log-expand-1").textContent).toBe("Show more");
    press(field(view.container, "session-log-expand-1"));
    expect(field(view.container, "session-log-expand-1").textContent).toBe("Show less");
    const empty = mount(<SessionTerminalViewer sessionId="empty" items={[]} />);
    expect(field(empty.container, "session-logs-empty").textContent).toContain("No logs");
    expect(empty.container.querySelector('[data-pw="session-log-filters"]')).toBeNull();
  });

  it("jumps to a hashed line and copies even when clipboard is missing", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    window.location.hash = "#L2";
    const view = mount(
      <SessionTerminalViewer sessionId="s3" items={[entry("one", 1), entry("two", 2)]} />,
    );
    act(() => {
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(field(view.container, "session-log-line-2").getAttribute("data-highlighted")).toBe(
      "true",
    );
    press(field(view.container, "session-log-line-link-1"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
    });
    press(field(view.container, "session-log-line-link-2"));
    window.location.hash = "";
  });
});
