import { stripAnsi } from "./session-log-ansi.ts";
import { errorPreview, eventPreview, isRecord, str, toolPreview } from "./session-log-preview.ts";

export type LogCategory =
  | "message"
  | "thinking"
  | "tool"
  | "event"
  | "error"
  | "system"
  | "output"
  | "other";

export const LOG_CATEGORIES: LogCategory[] = [
  "message",
  "thinking",
  "tool",
  "event",
  "error",
  "system",
  "output",
  "other",
];

export type ClassifiedLine = {
  category: LogCategory;
  typeLabel: string;
  preview: string;
  json: unknown | undefined;
};

const TOOL_TYPES = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "tool_use",
  "function_call",
  "tool_result",
]);
const THINKING_TYPES = new Set(["reasoning", "agent_reasoning", "thinking"]);
const MESSAGE_TYPES = new Set(["agent_message", "message"]);

export function parseJsonLine(line: string): object | undefined {
  const trimmed = stripAnsi(line).trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

export function classifyLogLine(raw: string): ClassifiedLine {
  const json = parseJsonLine(raw);
  if (json === undefined) {
    if (raw.startsWith("[system] ")) {
      return { category: "system", typeLabel: "system", preview: raw.slice(9), json: undefined };
    }
    return { category: "output", typeLabel: "output", preview: raw, json: undefined };
  }
  return { ...classifyJson(json), json };
}

function classifyJson(value: object): Omit<ClassifiedLine, "json"> {
  if (Array.isArray(value)) return { category: "other", typeLabel: "array", preview: "array" };
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  const item = isRecord(record.item) ? record.item : undefined;
  const nested =
    classifyNamedType(str(item, "type"), item) ??
    classifyClaude(type, record) ??
    classifyNamedType(type, record);
  if (nested) return nested;
  if (type === "error" || type === "turn.failed") {
    return { category: "error", typeLabel: type, preview: errorPreview(record) };
  }
  if (type === "system" || type.startsWith("system.")) {
    return {
      category: "system",
      typeLabel: type,
      preview: str(record, "message", "text") || type,
    };
  }
  if (type === "result" && record.is_error === true) {
    return {
      category: "error",
      typeLabel: "result",
      preview: str(record, "result", "error", "message") || "error",
    };
  }
  if (type.startsWith("turn.") || type.startsWith("thread.") || type === "result") {
    return { category: "event", typeLabel: type, preview: eventPreview(type, record) };
  }
  if (type) return { category: "other", typeLabel: type, preview: type };
  if (isRecord(record.error)) {
    return {
      category: "error",
      typeLabel: str(record.error, "type") || "error",
      preview: errorPreview(record),
    };
  }
  return { category: "other", typeLabel: "json", preview: "json" };
}

function classifyNamedType(name: string, value: Record<string, unknown> | undefined) {
  if (!name || !value) return undefined;
  if (THINKING_TYPES.has(name)) {
    return {
      category: "thinking" as const,
      typeLabel: name,
      preview: str(value, "text", "summary", "content"),
    };
  }
  if (MESSAGE_TYPES.has(name)) {
    return {
      category: "message" as const,
      typeLabel: name,
      preview: str(value, "text", "content"),
    };
  }
  if (TOOL_TYPES.has(name)) {
    return { category: "tool" as const, typeLabel: name, preview: toolPreview(name, value) };
  }
  return undefined;
}

function classifyClaude(type: string, value: Record<string, unknown>) {
  if (type !== "assistant" && type !== "user") return undefined;
  const message = isRecord(value.message) ? value.message : value;
  const content = message.content;
  if (typeof content === "string") {
    return { category: "message" as const, typeLabel: type, preview: content };
  }
  if (!Array.isArray(content)) {
    return { category: "message" as const, typeLabel: type, preview: type };
  }
  return classifyClaudeBlocks(type, content);
}

function classifyClaudeBlocks(type: string, content: unknown[]) {
  let thinking = "";
  let tool = "";
  let toolType = "";
  let text = "";
  for (const block of content) {
    if (!isRecord(block)) continue;
    const blockType = str(block, "type");
    if (blockType === "thinking" && !thinking) thinking = str(block, "thinking", "text");
    if ((blockType === "tool_use" || blockType === "tool_result") && !tool) {
      tool = str(block, "name", "id") || blockType;
      toolType = blockType;
    }
    if (blockType === "text" && !text) text = str(block, "text");
  }
  if (tool) return { category: "tool" as const, typeLabel: toolType, preview: tool };
  if (thinking && !text)
    return { category: "thinking" as const, typeLabel: "thinking", preview: thinking };
  if (text) return { category: "message" as const, typeLabel: type, preview: text };
  return { category: "message" as const, typeLabel: type, preview: type };
}
