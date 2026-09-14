import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SESSION_LOG_SETTINGS, SESSION_LOG_SETTINGS_ID } from "@auto-harness/shared";

import {
  getSessionLogSettings,
  putSessionLogSettings,
} from "./plane-storage-session-log-settings.ts";

const record = {
  id: SESSION_LOG_SETTINGS_ID,
  type: SESSION_LOG_SETTINGS_ID,
  ...DEFAULT_SESSION_LOG_SETTINGS,
  version: 1,
  createdAt: "now",
  updatedAt: "now",
} as const;

describe("session log settings storage", () => {
  it("returns null when the singleton is missing or the wrong type", async () => {
    await expect(
      getSessionLogSettings({
        tables: { integrations: "Integrations" } as never,
        doc: { send: vi.fn().mockResolvedValue({}) } as never,
      }),
    ).resolves.toBeNull();
    await expect(
      getSessionLogSettings({
        tables: { integrations: "Integrations" } as never,
        doc: { send: vi.fn().mockResolvedValue({ Item: { type: "slack" } }) } as never,
      }),
    ).resolves.toBeNull();
  });

  it("writes with a create fence and reports CAS failure", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      putSessionLogSettings(
        { tables: { integrations: "Integrations" } as never, doc: { send } as never },
        record,
        null,
      ),
    ).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          ConditionExpression: "attribute_not_exists(id)",
        }),
      }),
    );
    const conflict = new ConditionalCheckFailedException({
      message: "conflict",
      $metadata: {},
    });
    await expect(
      putSessionLogSettings(
        {
          tables: { integrations: "Integrations" } as never,
          doc: { send: vi.fn().mockRejectedValue(conflict) } as never,
        },
        record,
        1,
      ),
    ).resolves.toBe(false);
  });
});
