import type { IncomingMessage } from "node:http";

import { writeSystemAudit, writeSystemAuditBestEffort } from "./local-audit.ts";
import { readRawBody, send, sendInternalError, type RouteCtx } from "./local-http.ts";
import { parseSlackInboundEvent, verifySlackRequest } from "./slack-inbound.ts";
import type { SlackAppCredentials, SlackInboundEventRecord } from "./slack-oauth-types.ts";

export async function handleSlackEventsRoute(
  ctx: RouteCtx,
  credentials: SlackAppCredentials | undefined,
): Promise<void> {
  let raw: Buffer;
  try {
    raw = await readRawBody(ctx.req, 256 * 1024);
  } catch {
    send(ctx.res, 413, {
      error: { code: "PAYLOAD_TOO_LARGE", message: "Slack event exceeds route limit" },
    });
    return;
  }
  let integration: Awaited<ReturnType<RouteCtx["plane"]["getSlackInboundIntegrationDurable"]>>;
  try {
    integration = await ctx.plane.getSlackInboundIntegrationDurable();
  } catch {
    sendInternalError(ctx.res);
    return;
  }
  const signingSecret =
    integration?.installationMethod === "oauth"
      ? (credentials?.signingSecret ?? null)
      : integration
        ? integration.signingSecret
        : (credentials?.signingSecret ?? null);
  if (
    !signingSecret ||
    !verifySlackRequest({
      rawBody: raw,
      timestamp: header(ctx.req, "x-slack-request-timestamp"),
      signature: header(ctx.req, "x-slack-signature"),
      signingSecret,
      nowMs: Date.parse(ctx.plane.state.now()),
    })
  ) {
    send(ctx.res, 401, { error: { code: "UNAUTHENTICATED", message: "invalid Slack signature" } });
    return;
  }
  let parsed: ReturnType<typeof parseSlackInboundEvent>;
  try {
    parsed = parseSlackInboundEvent(JSON.parse(raw.toString("utf8")), ctx.plane.state.now());
  } catch {
    parsed = null;
  }
  if (!parsed) {
    send(ctx.res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid Slack event" } });
    return;
  }
  if (parsed.challenge !== undefined) return send(ctx.res, 200, { challenge: parsed.challenge });
  if (!integration) {
    if (!(await audit(ctx, "integration:slack:event:installation", "failed"))) return;
    send(ctx.res, 401, { error: { code: "UNAUTHENTICATED", message: "Slack is not installed" } });
    return;
  }
  if (!parsed.event) {
    // Unsupported signed events do not create a receipt, so their audit is
    // diagnostic just like accepted and duplicate receipt audits. An audit
    // outage must not make Slack retry an event we intentionally ignore.
    send(ctx.res, 200, { ok: true });
    void writeSystemAuditBestEffort(ctx, {
      action: "integration:slack:event:ignored",
      resourceType: "integration",
      resourceId: "slack",
      outcome: "success",
    });
    return;
  }
  if (!integration.workspaceId || integration.workspaceId !== parsed.event.workspaceId) {
    if (!(await audit(ctx, "integration:slack:event:workspace", "failed"))) return;
    send(ctx.res, 401, { error: { code: "UNAUTHENTICATED", message: "invalid Slack workspace" } });
    return;
  }
  // Manual ingress is enabled only after auth.test persisted the bot identity.
  // Slack auth.test does not reliably return api_app_id, so manual events are
  // fenced by the signed envelope's authorizations[].user_id instead. OAuth
  // rows retain their app-ID fence; legacy OAuth rows may lack app metadata.
  const invalidManualIdentity =
    integration.installationMethod === "manual" &&
    (!integration.botUserId || !parsed.event.authorizedUserIds?.includes(integration.botUserId));
  const invalidOAuthApp =
    integration.installationMethod === "oauth" &&
    integration.appId !== undefined &&
    parsed.event.apiAppId !== integration.appId;
  if (invalidManualIdentity || invalidOAuthApp) {
    if (!(await audit(ctx, "integration:slack:event:app", "failed"))) return;
    send(ctx.res, 401, { error: { code: "UNAUTHENTICATED", message: "invalid Slack app" } });
    return;
  }
  try {
    const created = ctx.plane.state.storage
      ? await ctx.plane.state.storage.putSlackInboundEvent(parsed.event)
      : putLocalEvent(ctx.plane.state.slackInboundEvents, parsed.event);
    // Flush the Slack ACK before the diagnostic append. The inbound event is
    // already committed/deduped, so audit latency or failure must not create
    // retry backpressure at the public webhook.
    send(ctx.res, 200, { ok: true });
    void writeSystemAuditBestEffort(ctx, {
      action: created ? "integration:slack:event:accepted" : "integration:slack:event:duplicate",
      resourceType: "integration",
      resourceId: "slack",
      outcome: "success",
    });
  } catch {
    if (!(await audit(ctx, "integration:slack:event:storage", "failed"))) return;
    sendInternalError(ctx.res);
  }
}

function putLocalEvent(
  records: Map<string, SlackInboundEventRecord>,
  event: SlackInboundEventRecord,
): boolean {
  const key = `${event.workspaceId}\0${event.eventId}`;
  if (records.has(key)) return false;
  records.set(key, event);
  return true;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

function audit(ctx: RouteCtx, action: string, outcome: "success" | "failed"): Promise<boolean> {
  return writeSystemAudit(ctx, {
    action,
    resourceType: "integration",
    resourceId: "slack",
    outcome,
  });
}
