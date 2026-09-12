import { createHmac, timingSafeEqual } from "node:crypto";

import type { SlackInboundEventRecord } from "./slack-oauth-types.ts";

const FIVE_MINUTES_SECONDS = 5 * 60;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

export function verifySlackRequest(input: {
  rawBody: Buffer;
  timestamp: string | undefined;
  signature: string | undefined;
  signingSecret: string;
  nowMs: number;
}): boolean {
  if (!input.timestamp || !input.signature || !/^v0=[a-f0-9]{64}$/.test(input.signature))
    return false;
  const seconds = Number(input.timestamp);
  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isFinite(input.nowMs) ||
    Math.abs(Math.floor(input.nowMs / 1000) - seconds) > FIVE_MINUTES_SECONDS
  ) {
    return false;
  }
  const expected = `v0=${createHmac("sha256", input.signingSecret)
    .update(`v0:${input.timestamp}:`)
    .update(input.rawBody)
    .digest("hex")}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(input.signature));
}

export function parseSlackInboundEvent(
  body: unknown,
  now: string,
): { challenge?: string; event?: SlackInboundEventRecord } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const envelope = body as Record<string, unknown>;
  if (envelope.type === "url_verification" && typeof envelope.challenge === "string") {
    return { challenge: envelope.challenge };
  }
  if (
    envelope.type !== "event_callback" ||
    typeof envelope.event_id !== "string" ||
    typeof envelope.team_id !== "string" ||
    !/^[TE][A-Z0-9]{1,63}$/.test(envelope.team_id) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(envelope.event_id)
  )
    return {};
  const apiAppId = envelope.api_app_id;
  if (
    apiAppId !== undefined &&
    (typeof apiAppId !== "string" || !/^[A-Z][A-Z0-9]{1,63}$/.test(apiAppId))
  )
    return {};
  const authorizedUserIds = parseAuthorizedUserIds(envelope.authorizations);
  if (envelope.authorizations !== undefined && !authorizedUserIds) return {};
  const event = envelope.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return {};
  const value = event as Record<string, unknown>;
  const kind =
    value.type === "app_mention"
      ? "app_mention"
      : value.type === "message" && value.channel_type === "im"
        ? "message.im"
        : null;
  if (!kind || typeof value.bot_id === "string" || value.subtype !== undefined) return {};
  if (
    typeof value.channel !== "string" ||
    !/^[CDG][A-Z0-9]{1,63}$/.test(value.channel) ||
    typeof value.user !== "string" ||
    !/^[UW][A-Z0-9]{1,63}$/.test(value.user) ||
    typeof value.text !== "string" ||
    typeof value.ts !== "string" ||
    !/^\d{1,20}(?:\.\d{1,10})?$/.test(value.ts) ||
    value.text.length > 40_000
  )
    return {};
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) return null;
  return {
    event: {
      workspaceId: envelope.team_id,
      ...(apiAppId === undefined ? {} : { apiAppId }),
      ...(authorizedUserIds === undefined ? {} : { authorizedUserIds }),
      eventId: envelope.event_id,
      type: kind,
      channelId: value.channel,
      userId: value.user,
      text: value.text,
      eventTs: value.ts,
      receivedAt: now,
      status: "pending",
      dueOrder: `${now}#${envelope.event_id}`,
      ttl: Math.floor(timestamp / 1000) + SEVEN_DAYS_SECONDS,
    },
  };
}

function parseAuthorizedUserIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const userIds = value.map((authorization) => {
    if (!authorization || typeof authorization !== "object" || Array.isArray(authorization))
      return null;
    const userId = (authorization as Record<string, unknown>).user_id;
    return typeof userId === "string" && /^U[A-Za-z0-9]{1,63}$/.test(userId) ? userId : null;
  });
  if (userIds.length === 0 || userIds.some((userId) => userId === null)) return undefined;
  return userIds as string[];
}
