import { describe, expect, it } from "vitest";

import {
  assertCanonicalTimestamp,
  assertWebhookFailureCode,
  assertWebhookQueryLimit,
  createWebhookDelivery,
  DEFAULT_WEBHOOK_MAX_ATTEMPTS,
  MAX_WEBHOOK_ATTEMPTS,
  MAX_WEBHOOK_DUE_QUERY,
  type WebhookEnqueueInput,
} from "./webhook-outbox.ts";

const input = {
  sessionId: "session-1",
  repositoryId: "repository-1",
  attemptId: "attempt-1",
  status: "completed" as const,
  occurredAt: "2026-08-12T20:00:00.000Z",
  destination: { configurationId: "operations", configurationVersion: 3 },
};

describe("webhook outbox contract", () => {
  it("builds stable, version-bound, secret-safe event and delivery ids", () => {
    const callerOwned = {
      ...input,
      prompt: "do not persist this prompt",
      secret: "do not persist this secret",
      destination: {
        ...input.destination,
        url: "https://private.example.test/hook",
        token: "do not persist this token",
      },
    } as WebhookEnqueueInput;
    const first = createWebhookDelivery(callerOwned);
    const repeated = createWebhookDelivery({
      ...input,
      occurredAt: "2026-08-12T20:01:00.000Z",
    });
    const replacedConfiguration = createWebhookDelivery({
      ...input,
      destination: { ...input.destination, configurationVersion: 4 },
    });

    expect(first.id).toBe(repeated.id);
    expect(first.event.id).toBe(repeated.event.id);
    expect(replacedConfiguration.event.id).toBe(first.event.id);
    expect(replacedConfiguration.id).not.toBe(first.id);
    expect(first).toMatchObject({
      state: "pending",
      attemptCount: 0,
      maxAttempts: DEFAULT_WEBHOOK_MAX_ATTEMPTS,
      dueAt: input.occurredAt,
      event: {
        schemaVersion: 1,
        type: "session.terminal",
        subject: { type: "session", id: input.sessionId },
        data: {
          repositoryId: input.repositoryId,
          attemptId: input.attemptId,
          status: input.status,
        },
      },
    });
    expect(JSON.stringify(first)).not.toMatch(/prompt|secret|token|private\.example/);
  });

  it("rejects ambiguous identifiers, timestamps, states, and retry bounds", () => {
    for (const key of ["sessionId", "repositoryId", "attemptId"] as const) {
      expect(() => createWebhookDelivery({ ...input, [key]: " " })).toThrow(`${key} must`);
    }
    expect(() =>
      createWebhookDelivery({
        ...input,
        destination: { ...input.destination, configurationId: "" },
      }),
    ).toThrow("configurationId must");
    expect(() => createWebhookDelivery({ ...input, status: "running" })).toThrow("terminal");
    expect(() => createWebhookDelivery({ ...input, occurredAt: "yesterday" })).toThrow("canonical");
    for (const configurationVersion of [0, 1.5]) {
      expect(() =>
        createWebhookDelivery({
          ...input,
          destination: { ...input.destination, configurationVersion },
        }),
      ).toThrow("configurationVersion");
    }
    for (const maxAttempts of [0, MAX_WEBHOOK_ATTEMPTS + 1, 1.5]) {
      expect(() => createWebhookDelivery({ ...input, maxAttempts })).toThrow("maxAttempts");
    }
  });

  it("validates canonical queue timestamps and bounded query sizes", () => {
    expect(() => assertCanonicalTimestamp(input.occurredAt, "time")).not.toThrow();
    expect(() => assertCanonicalTimestamp("2026-08-12", "time")).toThrow("canonical");
    expect(() => assertWebhookQueryLimit(1)).not.toThrow();
    expect(() => assertWebhookQueryLimit(MAX_WEBHOOK_DUE_QUERY)).not.toThrow();
    for (const limit of [0, MAX_WEBHOOK_DUE_QUERY + 1, 1.5]) {
      expect(() => assertWebhookQueryLimit(limit)).toThrow("limit");
    }
    expect(() => assertWebhookFailureCode("transient-failure")).not.toThrow();
    expect(() => assertWebhookFailureCode("secret: do not persist")).toThrow("failureCode");
  });
});
