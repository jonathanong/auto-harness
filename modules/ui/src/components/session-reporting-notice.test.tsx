import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionReportingNotice } from "./session-reporting-notice.tsx";

describe("required reporting notices", () => {
  it("separates completed work from undelivered or unavailable evidence", () => {
    const html = renderToStaticMarkup(
      <SessionReportingNotice
        session={{
          id: "session",
          status: "completed",
          reporting: {
            protocolVersion: 1,
            mode: "autonomous",
            deliveryStatus: "delivered",
            feedbackCoverage: "unavailable",
            completionStatus: "incomplete",
          },
        }}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Work is completed");
    expect(html).toContain("Evidence: unavailable");
    expect(html).toContain("reporting completion is blocked");
  });
  it("shows explicit admission failure and omits unsupported historical results", () => {
    expect(
      renderToStaticMarkup(
        <SessionReportingNotice
          session={{
            id: "session",
            status: "queued",
            reporting: {
              protocolVersion: 1,
              mode: "autonomous",
              deliveryStatus: "blocked",
              feedbackCoverage: "not-started",
              completionStatus: "in-progress",
            },
          }}
        />,
      ),
    ).toContain("Autonomous command admission is blocked");
    expect(
      renderToStaticMarkup(
        <SessionReportingNotice session={{ id: "session", status: "queued" }} />,
      ),
    ).toBe("");
  });
  it("shows delivered assessments and bounded observations without an admission warning", () => {
    const html = renderToStaticMarkup(
      <SessionReportingNotice
        session={{
          id: "session",
          status: "completed",
          completedAt: "2026-09-27T20:00:00.000Z",
          reporting: {
            protocolVersion: 1,
            mode: "autonomous",
            deliveryStatus: "delivered",
            feedbackCoverage: "complete",
            completionStatus: "complete",
          },
          result: {
            summary: "Done",
            summarySource: "harness",
            feedback: {
              schemaVersion: 1,
              completionKind: "changed",
              feedbackCoverage: "complete",
              assessments: {
                architecture: "finding",
                sandbox: "none-observed",
                tools: "none-observed",
              },
              assessmentEvidence: {
                architecture: "Inspected module boundaries.",
                sandbox: "Inspected this attempt.",
                tools: "Validated this scoped change.",
              },
              toolAssessments: [
                { name: "Vitest", status: "used", reason: "Verified the module contract." },
              ],
              findings: [
                {
                  category: "architecture",
                  recurrence: "recurring",
                  summary: "Observed unnecessary coupling.",
                },
              ],
              droppedCount: 0,
            },
          },
        }}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Observed unnecessary coupling.");
    expect(html).toContain("Verified the module contract.");
    expect(html).not.toContain("admission is blocked");
    expect(html).not.toContain("reporting completion is blocked");
  });
});
