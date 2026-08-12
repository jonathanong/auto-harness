import { describe, expect, it } from "vitest";

import { compareSessionToCursor, compareSessions } from "./control-plane-session-order.ts";
import type { SessionRecord } from "./db/types.ts";

function session(id: string, createdAt: string, priority: number): SessionRecord {
  return { id, createdAt, priority } as SessionRecord;
}

describe("session ordering", () => {
  it("orders every supported sort and respects a cursor", () => {
    const first = session("a", "2026-01-01", 1);
    const second = session("b", "2026-01-02", 2);
    const position = { createdAt: first.createdAt, id: first.id, priority: first.priority };
    expect(compareSessions(first, second, "latest")).toBeGreaterThan(0);
    expect(compareSessions(first, second, "oldest")).toBeLessThan(0);
    expect(compareSessions(first, second, "priority_desc")).toBeGreaterThan(0);
    expect(compareSessions(first, second, "priority_asc")).toBeLessThan(0);
    expect(compareSessionToCursor(second, position, "latest")).toBeLessThan(0);
    expect(compareSessionToCursor(second, position, "oldest")).toBeGreaterThan(0);
    expect(compareSessionToCursor(second, position, "priority_desc")).toBeLessThan(0);
    expect(compareSessionToCursor(second, position, "priority_asc")).toBeGreaterThan(0);

    const samePriority = session("c", "2026-01-03", 1);
    expect(compareSessions(first, samePriority, "priority_desc")).toBeGreaterThan(0);
    expect(compareSessions(first, samePriority, "priority_asc")).toBeLessThan(0);
    expect(compareSessionToCursor(samePriority, position, "priority_desc")).toBeLessThan(0);
    expect(compareSessionToCursor(samePriority, position, "priority_asc")).toBeGreaterThan(0);

    const sameDate = session("c", "2026-01-01", 1);
    expect(compareSessions(first, sameDate, "latest")).toBeGreaterThan(0);
    expect(compareSessions(first, sameDate, "oldest")).toBeLessThan(0);
    expect(compareSessions(first, sameDate, "priority_desc")).toBeGreaterThan(0);
    expect(compareSessions(first, sameDate, "priority_asc")).toBeLessThan(0);
    expect(compareSessionToCursor(sameDate, position, "latest")).toBeLessThan(0);
    expect(compareSessionToCursor(sameDate, position, "oldest")).toBeGreaterThan(0);
    expect(compareSessionToCursor(sameDate, position, "priority_desc")).toBeLessThan(0);
    expect(compareSessionToCursor(sameDate, position, "priority_asc")).toBeGreaterThan(0);
  });
});
