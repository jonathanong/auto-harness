// @vitest-environment happy-dom

import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { field, mount, press, reset, setValue } from "./action-form-test-helpers.ts";
import { SessionTerminalControls } from "./session-terminal-controls.tsx";

afterEach(reset);

describe("SessionTerminalControls", () => {
  it("forwards search, font, fullscreen, and download actions", () => {
    const setQuery = vi.fn();
    const search = vi.fn();
    const changeFontSize = vi.fn();
    const toggleFullscreen = vi.fn();
    const download = vi.fn();
    const searchInputRef = createRef<HTMLInputElement>();
    const view = mount(
      <SessionTerminalControls
        sessionId="s-1"
        searchInputRef={searchInputRef}
        query="log"
        setQuery={setQuery}
        searchResult="1 of 2"
        search={search}
        fontSize={14}
        changeFontSize={changeFontSize}
        fullscreen={false}
        toggleFullscreen={toggleFullscreen}
        download={download}
      />,
    );

    const input = field<HTMLInputElement>(view.container, "session-terminal-search");
    setValue(input, "error");
    expect(setQuery).toHaveBeenCalledWith("error");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    );
    expect(search).toHaveBeenCalledWith("next");
    expect(search).toHaveBeenCalledWith("previous");

    press(field(view.container, "session-terminal-search-previous"));
    press(field(view.container, "session-terminal-search-next"));
    press(field(view.container, "session-terminal-font-decrease"));
    press(field(view.container, "session-terminal-font-increase"));
    press(field(view.container, "session-terminal-fullscreen"));
    press(field(view.container, "session-terminal-download"));
    expect(changeFontSize).toHaveBeenCalledWith(-1);
    expect(changeFontSize).toHaveBeenCalledWith(1);
    expect(toggleFullscreen).toHaveBeenCalled();
    expect(download).toHaveBeenCalled();
  });
});
