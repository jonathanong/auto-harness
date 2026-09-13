import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  SESSION_QUEUED_WAIT_COPY,
  SessionStatusCell,
  SessionStatusDetail,
  sessionInfrastructureRetryReason,
  sessionErrorLabel,
  sessionStatusReason,
} from "./session-status-cell.tsx";

describe("SessionStatusCell", () => {
  it("maps only documented terminal reasons", () => {
    expect(sessionStatusReason("usage_limit")).toBe("Usage limit");
    expect(sessionStatusReason("queue_expired")).toBe("Queue expired");
    expect(sessionStatusReason("checkout_fetch_failed")).toBe("Checkout fetch failed");
    expect(sessionStatusReason("host_lost")).toBe("Host lost");
    expect(sessionInfrastructureRetryReason("host_lost")).toBe("Host lost before launch");
    expect(sessionErrorLabel("checkout_fetch_failed")).toBe("Checkout fetch failed");
    expect(sessionErrorLabel("usage_limit")).toBe("Usage limit");
    expect(sessionErrorLabel("queue_expired")).toBe("Queue expired");
    expect(sessionErrorLabel("unknown_failure")).toBe("unknown_failure");
    expect(sessionErrorLabel(null)).toBeNull();
    expect(sessionStatusReason("setup_failed")).toBeNull();
    expect(sessionStatusReason(null)).toBeNull();
  });

  it("preserves the badge and renders a failure reason", () => {
    const usage = renderToStaticMarkup(
      <SessionStatusCell status="failed" errorCode="usage_limit" sessionId="usage" />,
    );
    expect(usage).toContain("failed");
    expect(usage).toContain("Usage limit");
    expect(usage).toContain('data-pw="session-status-reason-usage"');

    const expired = renderToStaticMarkup(
      <SessionStatusCell
        status="failed"
        errorCode="queue_expired"
        errorMessage="queue TTL expired before capacity became available"
        sessionId="expired"
      />,
    );
    expect(expired).toContain("Queue expired");
    expect(expired).not.toContain("queue TTL expired before capacity became available");

    const ordinary = renderToStaticMarkup(
      <SessionStatusCell
        status="failed"
        errorCode="setup_failed"
        errorMessage="Failed to checkout resolved ref: index.lock exists"
        sessionId="ordinary"
      />,
    );
    expect(ordinary).toContain("failed");
    expect(ordinary).toContain("Failed to checkout resolved ref: index.lock exists");
    expect(ordinary).toContain('data-pw="session-status-reason-ordinary"');

    const codeFallback = renderToStaticMarkup(
      <SessionStatusCell status="failed" errorCode="setup_failed" sessionId="code-fallback" />,
    );
    expect(codeFallback).toContain("setup_failed");

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

  it("shows a bounded retry in queued status without changing ordinary status copy", () => {
    const list = renderToStaticMarkup(
      <SessionStatusCell
        status="queued"
        sessionId="retry"
        infrastructureRetryCount={1}
        lastInfrastructureErrorCode="host_lost"
      />,
    );
    expect(list).toContain('data-pw="session-status-retry-retry"');
    expect(list).toContain("Automatic retry 1 of 1 in progress after Host lost before launch.");

    const detail = renderToStaticMarkup(
      <SessionStatusDetail
        status="queued"
        infrastructureRetryCount={1}
        lastInfrastructureErrorCode="checkout_fetch_failed"
      />,
    );
    expect(detail).toContain('data-pw="session-detail-status-retry"');
    expect(detail).toContain("Checkout fetch failed");
    expect(
      renderToStaticMarkup(<SessionStatusDetail status="running" infrastructureRetryCount={1} />),
    ).not.toContain("Automatic retry");
  });

  it("uses friendly labels for terminal infrastructure failures", () => {
    expect(
      renderToStaticMarkup(
        <SessionStatusCell status="failed" errorCode="host_lost" sessionId="lost" />,
      ),
    ).toContain("Host lost");
  });
});
