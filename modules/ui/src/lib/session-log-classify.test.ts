import { describe, expect, it } from "vitest";

import { classifyLogLine, parseJsonLine } from "./session-log-classify.ts";

const json = (value: unknown) => JSON.stringify(value);

describe("classifyLogLine", () => {
  it("parses JSONL objects and arrays and ignores invalid lines", () => {
    expect(parseJsonLine('  {"ok":true}  ')).toEqual({ ok: true });
    expect(parseJsonLine("[1]")).toEqual([1]);
    expect(parseJsonLine("true")).toBeUndefined();
    expect(parseJsonLine("{nope")).toBeUndefined();
    expect(classifyLogLine("hello")).toMatchObject({ category: "output", preview: "hello" });
    expect(classifyLogLine("[system] done")).toMatchObject({
      category: "system",
      preview: "done",
    });
    expect(classifyLogLine("[1,2]")).toMatchObject({ category: "other", typeLabel: "array" });
  });

  it("classifies Codex envelopes from type and item.type", () => {
    expect(
      classifyLogLine(
        json({ type: "item.completed", item: { type: "agent_message", text: "hi" } }),
      ),
    ).toMatchObject({ category: "message", typeLabel: "agent_message", preview: "hi" });
    expect(
      classifyLogLine(
        json({ type: "item.completed", item: { type: "reasoning", summary: "think" } }),
      ),
    ).toMatchObject({ category: "thinking", preview: "think" });
    expect(
      classifyLogLine(
        json({
          type: "item.started",
          item: { type: "command_execution", command: "sed" },
        }),
      ),
    ).toMatchObject({ category: "tool", typeLabel: "command_execution", preview: "sed" });
    expect(classifyLogLine(json({ type: "thread.started" }))).toMatchObject({
      category: "event",
      typeLabel: "thread.started",
    });
    expect(classifyLogLine(json({ type: "turn.started" }))).toMatchObject({ category: "event" });
    expect(
      classifyLogLine(
        json({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 5 } }),
      ),
    ).toMatchObject({ category: "event", preview: "input 4 · output 5" });
    expect(classifyLogLine(json({ type: "result" }))).toMatchObject({ category: "event" });
    expect(classifyLogLine(json({ type: "error", message: "nope" }))).toMatchObject({
      category: "error",
      preview: "nope",
    });
    expect(classifyLogLine(json({ type: "turn.failed", error: { message: "x" } }))).toMatchObject({
      category: "error",
      preview: "x",
    });
    expect(classifyLogLine(json({ type: "system", message: "boot" }))).toMatchObject({
      category: "system",
      preview: "boot",
    });
    expect(classifyLogLine(json({ type: "system.init" }))).toMatchObject({
      category: "system",
      typeLabel: "system.init",
    });
    expect(classifyLogLine(json({ type: "custom" }))).toMatchObject({
      category: "other",
      typeLabel: "custom",
    });
    expect(classifyLogLine(json({ ok: true }))).toMatchObject({
      category: "other",
      typeLabel: "json",
    });
    expect(classifyLogLine(json({ type: 1 }))).toMatchObject({
      category: "other",
      typeLabel: "json",
    });
    expect(classifyLogLine(json({ type: "agent_message", text: "top" }))).toMatchObject({
      category: "message",
      preview: "top",
    });
    expect(
      classifyLogLine(json({ type: "item.completed", item: { type: "unknown" } })),
    ).toMatchObject({
      category: "other",
      typeLabel: "item.completed",
    });
  });

  it("classifies Claude stream-json content blocks", () => {
    expect(classifyLogLine(json({ type: "assistant", content: "hi" }))).toMatchObject({
      category: "message",
      preview: "hi",
    });
    expect(classifyLogLine(json({ type: "user", message: { role: "user" } }))).toMatchObject({
      category: "message",
      preview: "user",
    });
    expect(
      classifyLogLine(
        json({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } }),
      ),
    ).toMatchObject({ category: "thinking", preview: "hmm" });
    expect(
      classifyLogLine(
        json({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "bash" }] },
        }),
      ),
    ).toMatchObject({ category: "tool", typeLabel: "tool_use", preview: "bash" });
    expect(
      classifyLogLine(
        json({
          type: "user",
          message: { content: [{ type: "tool_result", id: "1" }] },
        }),
      ),
    ).toMatchObject({ category: "tool", typeLabel: "tool_result", preview: "1" });
    expect(
      classifyLogLine(
        json({
          type: "assistant",
          message: {
            content: [{ type: "thinking", text: "x" }, { type: "text", text: "hello" }, "skip"],
          },
        }),
      ),
    ).toMatchObject({ category: "message", preview: "hello" });
    expect(classifyLogLine(json({ type: "assistant", message: { content: [] } }))).toMatchObject({
      category: "message",
      preview: "assistant",
    });
    expect(
      classifyLogLine(json({ type: "assistant", message: { content: [{ type: "tool_use" }] } })),
    ).toMatchObject({ category: "tool", typeLabel: "tool_use", preview: "tool_use" });
    expect(
      classifyLogLine(json({ type: "item.completed", item: { type: "file_change", changes: [] } })),
    ).toMatchObject({ category: "tool", typeLabel: "file_change" });
  });
});
