import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  SESSION_QUEUED_WAIT_COPY,
  SessionStatusCell,
  SessionStatusDetail,
  sessionStatusReason,
} from "./session-status-cell.tsx";

describe("SessionStatusCell", () => {
  it("maps only documented terminal reasons", () => {
    expect(sessionStatusReason("usage_limit")).toBe("Usage limit");
    expect(sessionStatusReason("queue_expired")).toBe("Queue expired");
    expect(sessionStatusReason("setup_failed")).toBeNull();
    expect(sessionStatusReason(null)).toBeNull();
  });

  it("preserves the badge and renders an accessible subtitle only when mapped", () => {
    const usage = renderToStaticMarkup(
      <SessionStatusCell status="failed" errorCode="usage_limit" sessionId="usage" />,
    );
    expect(usage).toContain("failed");
    expect(usage).toContain("Usage limit");
    expect(usage).toContain('data-pw="session-status-reason-usage"');

    const expired = renderToStaticMarkup(
      <SessionStatusCell status="failed" errorCode="queue_expired" sessionId="expired" />,
    );
    expect(expired).toContain("Queue expired");

    const ordinary = renderToStaticMarkup(
      <SessionStatusCell status="failed" errorCode="setup_failed" sessionId="ordinary" />,
    );
    expect(ordinary).toContain("failed");
    expect(ordinary).not.toContain("session-status-reason-ordinary");

    const reassigned = renderToStaticMarkup(
      <SessionStatusCell status="running" errorCode="usage_limit" sessionId="reassigned" />,
    );
    expect(reassigned).toContain("running");
    expect(reassigned).not.toContain("Usage limit");
    expect(reassigned).not.toContain("session-status-reason-reassigned");
  });

  it("uses the same documented reason on session detail", () => {
    const expired = renderToStaticMarkup(
      <SessionStatusDetail status="failed" errorCode="queue_expired" />,
    );
    expect(expired).toContain('data-pw="session-detail-status"');
    expect(expired).toContain('data-pw="session-detail-status-reason"');
    expect(expired).toContain("Queue expired");
    const ordinary = renderToStaticMarkup(
      <SessionStatusDetail status="failed" errorCode="setup_failed" />,
    );
    expect(ordinary).not.toContain("session-detail-status-reason");
    const reassigned = renderToStaticMarkup(
      <SessionStatusDetail status="running" errorCode="usage_limit" />,
    );
    expect(reassigned).toContain("running");
    expect(reassigned).not.toContain("Usage limit");
    expect(reassigned).not.toContain("session-detail-status-reason");
  });

  it("explains the one-minute scheduler wait only on queued session detail", () => {
    const queued = renderToStaticMarkup(<SessionStatusDetail status="queued" />);
    expect(queued).toContain(SESSION_QUEUED_WAIT_COPY);
    expect(renderToStaticMarkup(<SessionStatusDetail status="completed" />)).not.toContain(
      SESSION_QUEUED_WAIT_COPY,
    );
    expect(
      renderToStaticMarkup(<SessionStatusCell status="queued" sessionId="queued" />),
    ).not.toContain(SESSION_QUEUED_WAIT_COPY);
  });
});
