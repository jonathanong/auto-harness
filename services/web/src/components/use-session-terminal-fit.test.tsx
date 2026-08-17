// @vitest-environment happy-dom

import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { mountForm } from "./form-test-helpers.tsx";
import { SessionTerminalViewer } from "./session-terminal-viewer.tsx";

const mocks = vi.hoisted(() => ({
  fit: vi.fn(),
  refresh: vi.fn(),
  terminalOptions: vi.fn(),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = mocks.fit;
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext() {}
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    rows = 40;
    options: { fontSize?: number } = {};
    buffer = { active: { viewportY: 0, baseY: 0 } };
    loadAddon() {}
    open() {}
    write = vi.fn((_text: string, callback?: () => void) => callback?.());
    reset() {}
    refresh = mocks.refresh;
    scrollToBottom() {}
    dispose() {}
    constructor(options: unknown) {
      mocks.terminalOptions(options);
    }
  },
}));

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useSessionTerminal fit behavior", () => {
  it("no longer hardcodes a fixed grid, fits once on mount, and re-fits on resize", async () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe() {}
        disconnect() {}
      },
    );

    mountForm(
      <SessionTerminalViewer
        sessionId="resize"
        items={[{ timestampSeq: "a", seq: 1, stream: "stdout", content: "hi\n", timestamp: "now" }]}
      />,
    );
    await settle();

    const options = mocks.terminalOptions.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options).not.toHaveProperty("cols");
    expect(options).not.toHaveProperty("rows");
    expect(mocks.fit).toHaveBeenCalledTimes(1);

    mocks.fit.mockClear();
    mocks.refresh.mockClear();
    resizeCallback?.([], {} as ResizeObserver);
    expect(mocks.fit).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("swallows a fit error from a momentarily hidden (0x0) host", async () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    mountForm(
      <SessionTerminalViewer
        sessionId="resize-hidden"
        items={[{ timestampSeq: "a", seq: 1, stream: "stdout", content: "hi\n", timestamp: "now" }]}
      />,
    );
    await settle();
    mocks.refresh.mockClear();
    mocks.fit.mockImplementationOnce(() => {
      throw new Error("host is 0x0 mid-transition");
    });

    expect(() => resizeCallback?.([], {} as ResizeObserver)).not.toThrow();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
