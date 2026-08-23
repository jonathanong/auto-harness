import { describe, expect, it } from "vitest";

import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import { createSessionDrainDurable } from "./control-plane-session-drains.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionDrainRecord } from "./db/plane-storage.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function drain(): SessionDrainRecord {
  return {
    scopeKey: "repo#principal",
    recordKey: "OP#drain-audit",
    operationId: "drain-audit",
    repositoryId: "repo",
    principalId: "principal",
    status: "draining",
    requestedAt: NOW,
    updatedAt: NOW,
    deadlineAt: "2026-01-01T00:15:00.000Z",
    queuedCount: 0,
    runningCount: 0,
    cancelledCount: 0,
  };
}

describe("session drain transactional audits", () => {
  it("couples deterministic creation and terminal audits to their drain writes", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const creationAudits: unknown[] = [];
    const terminalAudits: unknown[] = [];
    setDurableReadStorage(state, {
      getRepository: async () => ({
        id: "repo",
        name: "repo",
        url: "/repo",
        defaultBranch: "main",
        createdAt: NOW,
        updatedAt: NOW,
      }),
      createOrGetSessionDrain: async (_record: SessionDrainRecord, audit: unknown) => {
        creationAudits.push(audit);
        return { created: true, drain: drain() };
      },
      listSessionsForDrain: async () => [],
      updateSessionDrain: async (_record: SessionDrainRecord, audit: unknown) => {
        terminalAudits.push(audit);
        return true;
      },
    });

    await expect(
      createSessionDrainDurable(state, "repo", "principal", "stable-key", {
        id: "actor-id",
        kind: "service-account",
        role: "author",
      }),
    ).resolves.toMatchObject({ created: true, drain: { status: "succeeded" } });
    expect(creationAudits).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^audit-session-drain-drain-[a-f0-9]{32}-create$/),
        actor: { id: "actor-id", kind: "service-account", role: "author" },
        action: "session-drain:create",
      }),
    ]);
    expect(terminalAudits).toEqual([
      expect.objectContaining({
        id: "audit-session-drain-drain-audit-succeeded",
        actor: { id: "system", kind: "system", role: "system" },
        action: "session-drain:succeeded",
      }),
    ]);
    expect([...state.auditLogs.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "session-drain:create" }),
        expect.objectContaining({ action: "session-drain:succeeded" }),
      ]),
    );
  });
});
