import type { SessionRecord } from "./db/types.ts";

/** A minimal terminal-or-running session record for prior-context route tests,
 * with just enough fields to satisfy `SessionRecord` and the route's access checks. */
export function minimalSession(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
  return {
    repositoryId: "repo",
    prompt: "p",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetDisplayNames: ["echo"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T00:01:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    status: "completed",
    queueShard: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "prompt",
    source: "api",
    ...overrides,
  };
}
