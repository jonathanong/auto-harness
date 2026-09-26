import type { SlackDeliveryRecord } from "../src/slack-delivery-types.ts";
import { DEFAULT_SLACK_NOTIFICATIONS } from "../src/slack-integration-types.ts";

/**
 * Minimal storage surface for asserting that a durable writer enqueued Slack lifecycle
 * deliveries: an insert-only outbox plus an enabled Slack integration. Spread `storage`
 * into a durable-read storage stub and read the enqueued ids from `ids()`.
 */
export function slackOutboxStub() {
  const items = new Map<string, SlackDeliveryRecord>();
  return {
    ids: () => [...items.keys()],
    storage: {
      enqueue: async (record: SlackDeliveryRecord) => {
        if (items.has(record.id)) return "exists" as const;
        items.set(record.id, structuredClone(record));
        return "created" as const;
      },
      get: async (id: string) => structuredClone(items.get(id) ?? null),
      getSlackIntegration: async () => ({
        id: "slack",
        type: "slack",
        enabled: true,
        defaultChannel: "#ops",
        notifications: DEFAULT_SLACK_NOTIFICATIONS,
      }),
      getRepository: async () => null,
      putArchive: async () => undefined,
      listLogs: async () => [],
    },
  };
}
