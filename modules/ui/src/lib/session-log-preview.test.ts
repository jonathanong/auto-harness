import { describe, expect, it } from "vitest";

import { errorPreview, eventPreview, isRecord, str, toolPreview } from "./session-log-preview.ts";

describe("session log previews", () => {
  it("guards records and string fields", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(str("nope", "a")).toBe("");
    expect(str({ a: 1, b: "ok" }, "a", "b")).toBe("ok");
    expect(str({ a: "" }, "a")).toBe("");
  });

  it("summarizes tools, usage, and errors", () => {
    expect(
      toolPreview("command_execution", { command: "ls", status: "completed", exit_code: 0 }),
    ).toBe("ls · completed · exit 0");
    expect(toolPreview("command_execution", { command: "ls", exit_code: "1" })).toBe("ls · exit 1");
    expect(toolPreview("command_execution", { command: "ls" })).toBe("ls");
    expect(
      toolPreview("file_change", {
        changes: [{ path: "/tmp/a.md", kind: "delete" }, "skip", { path: "", kind: "" }],
      }),
    ).toBe("delete a.md");
    expect(toolPreview("mcp_tool_call", { name: "search" })).toBe("search");
    expect(toolPreview("web_search", {})).toBe("web_search");
    expect(eventPreview("turn.started", {})).toBe("turn.started");
    expect(eventPreview("turn.completed", { usage: [] })).toBe("turn.completed");
    expect(eventPreview("turn.completed", { usage: { input_tokens: 3 } })).toBe("input 3");
    expect(eventPreview("turn.completed", { usage: { outputTokens: 9 } })).toBe("output 9");
    expect(eventPreview("turn.completed", { usage: { input_tokens: 1, output_tokens: 2 } })).toBe(
      "input 1 · output 2",
    );
    expect(eventPreview("turn.completed", { usage: {} })).toBe("turn.completed");
    expect(toolPreview("file_change", { changes: [{ path: "README", kind: "add" }] })).toBe(
      "add README",
    );
    expect(errorPreview({ message: "boom" })).toBe("boom");
    expect(errorPreview({ error: { message: "nested" } })).toBe("nested");
    expect(errorPreview({ type: "error" })).toBe("error");
    expect(errorPreview({})).toBe("error");
  });
});
