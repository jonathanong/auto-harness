import type { SessionSummary } from "./session-detail-types.ts";

/** Reporting completion is independent of the work's terminal status. */
export function SessionReportingNotice({ session }: { session: SessionSummary }) {
  const reporting = session.reporting;
  if (!reporting) return null;
  const incomplete = reporting.completionStatus === "incomplete";
  const feedback = session.result?.feedback;
  return (
    <div
      role={incomplete || reporting.deliveryStatus === "blocked" ? "alert" : "status"}
      className="rounded border p-3 text-sm"
      data-pw="session-reporting-status"
    >
      <p>
        Required feedback: {reporting.deliveryStatus}. Evidence: {reporting.feedbackCoverage}.
      </p>
      {incomplete ? (
        <p>
          Work is {session.status}; reporting completion is blocked until delivery and the required
          evidence are complete.
        </p>
      ) : null}
      {reporting.deliveryStatus === "blocked" && !session.completedAt ? (
        <p>
          Autonomous command admission is blocked by unavailable reporting configuration or
          connection.
        </p>
      ) : null}
      {feedback ? (
        <p>
          Architecture: {feedback.assessments.architecture}. Sandbox: {feedback.assessments.sandbox}
          . Tools: {feedback.assessments.tools}.
        </p>
      ) : null}
      {feedback ? (
        <ul>
          {(["architecture", "sandbox", "tools"] as const).map((area) => (
            <li key={area}>
              {area}: {feedback.assessmentEvidence[area]}
            </li>
          ))}
          {feedback.toolAssessments.map((tool) => (
            <li key={tool.name}>
              {tool.name}: {tool.status}. {tool.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {feedback?.findings.length ? (
        <ul>
          {feedback.findings.map((finding, index) => (
            <li key={`${finding.category}-${index}`}>
              {finding.category}: {finding.summary}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
