// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { THEME_CHANGE_EVENT } from "@auto-harness/ui";

import { mountForm } from "./form-test-helpers.tsx";
import { SessionTerminalViewer } from "./session-terminal-viewer.tsx";

type MockTerminalOptions = { fontSize?: number; theme?: unknown };

const mocks = vi.hoisted(() => ({
  write: vi.fn((_text: string, callback?: () => void) => callback?.()),
  refresh: vi.fn(),
  terminalOptions: vi.fn(),
  instances: [] as { options: MockTerminalOptions }[],
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext() {}
    findPrevious() {}
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    rows = 40;
    options: MockTerminalOptions = {};
    buffer = { active: { viewportY: 0, baseY: 0 } };
    loadAddon() {}
    open() {}
    write = mocks.write;
    reset() {}
    refresh = mocks.refresh;
    scrollToBottom() {}
    dispose() {}
    constructor(options: MockTerminalOptions) {
      mocks.terminalOptions(options);
      mocks.instances.push(this);
    }
  },
}));

function stubComputedTerminalTheme(values: Record<string, string>): void {
  // vi.stubGlobal (not vi.spyOn) so the shared afterEach's existing vi.unstubAllGlobals() cleans
  // this up automatically.
  vi.stubGlobal(
    "getComputedStyle",
    () => ({ getPropertyValue: (name: string) => values[name] ?? "" }) as CSSStyleDeclaration,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SessionTerminalViewer theme", () => {
  it("reads terminal colors from CSS variables and rebuilds them live on a theme change", async () => {
    stubComputedTerminalTheme({
      "--terminal-background": "224 55% 8%",
      "--terminal-foreground": "220 13% 91%",
      "--terminal-cursor": "220 13% 91%",
    });

    const view = mountForm(<SessionTerminalViewer sessionId="theme" items={[]} />);
    await settle();
    expect(mocks.terminalOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: {
          background: "hsl(224 55% 8%)",
          foreground: "hsl(220 13% 91%)",
          cursor: "hsl(220 13% 91%)",
        },
      }),
    );

    stubComputedTerminalTheme({
      "--terminal-background": "224 30% 12%",
      "--terminal-foreground": "220 13% 91%",
      "--terminal-cursor": "220 13% 91%",
    });
    mocks.refresh.mockClear();
    act(() => window.dispatchEvent(new Event(THEME_CHANGE_EVENT)));

    const instance = mocks.instances.at(-1);
    expect(instance?.options.theme).toEqual({
      background: "hsl(224 30% 12%)",
      foreground: "hsl(220 13% 91%)",
      cursor: "hsl(220 13% 91%)",
    });
    expect(mocks.refresh).toHaveBeenCalled();
    view.unmount();
  });

  it("falls back to the light-mode literal when a CSS variable is unset", async () => {
    stubComputedTerminalTheme({});
    const view = mountForm(<SessionTerminalViewer sessionId="theme-fallback" items={[]} />);
    await settle();
    expect(mocks.terminalOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: { background: "#090f1f", foreground: "#e5e7eb", cursor: "#e5e7eb" },
      }),
    );
    view.unmount();
  });
});
