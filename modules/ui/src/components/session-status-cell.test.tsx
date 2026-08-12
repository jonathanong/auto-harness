import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionStatusCell, sessionStatusReason } from "./session-status-cell.tsx";

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
  });
});
