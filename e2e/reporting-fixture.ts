function reportingRepository(slug: string) {
  return {
    id: `e2e-reporting-${slug}`,
    name: `e2e-reporting-${slug}`,
    repository: `example/e2e-${slug}`,
  };
}

/** Each assignment scenario has its own trusted policy and immutable catalog row. */
export const E2E_REPORTING_REPOSITORIES = {
  offline: reportingRepository("offline"),
  usage: reportingRepository("usage"),
  terminalError: reportingRepository("terminal-error"),
  hostPane: reportingRepository("host-pane"),
  liveLogs: reportingRepository("live-logs"),
  orchestration: reportingRepository("orchestration"),
  smokeEcho: reportingRepository("smoke-echo"),
  smokeFailure: reportingRepository("smoke-failure"),
  statusBadges: reportingRepository("status-badges"),
  terminalClipping: reportingRepository("terminal-clipping"),
} as const;
