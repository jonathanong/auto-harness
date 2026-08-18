import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Breadcrumbs, DetailHeader } from "./detail-header.tsx";
import { ProviderAccountHealth, isProviderAccountPaused } from "./provider-account-health.tsx";
import { SessionExecutionSummary } from "./session-execution-summary.tsx";
import { SessionRouteSummary } from "./session-route-summary.tsx";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(node);
}

afterEach(() => vi.useRealTimers());

describe("shared data display composites", () => {
  it("renders linked and current breadcrumbs, with optional detail actions", () => {
    expect(
      render(
        <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Current" }]} pw="trail" />,
      ),
    ).toContain('data-pw="trail"');
    const header = render(
      <DetailHeader
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Run" }]}
        title="Session"
        titlePw="session-title"
        actions={<button type="button">Retry</button>}
      />,
    );
    expect(header).toContain('data-pw="breadcrumb-0"');
    expect(header).toContain('href="/"');
    expect(header).toContain('data-pw="breadcrumb-1"');
    expect(header).toContain('data-pw="session-title"');
    expect(header).toContain(">Retry</button>");
    expect(render(<DetailHeader breadcrumbs={[]} title={<>Empty</>} />)).not.toContain("Retry");
  });

  it("shows available, expired, and actively paused provider accounts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
    expect(isProviderAccountPaused(null)).toBe(false);
    expect(isProviderAccountPaused("2026-08-10T11:59:00.000Z")).toBe(false);
    expect(isProviderAccountPaused("2026-08-10T12:01:00.000Z")).toBe(true);
    expect(
      render(<ProviderAccountHealth usageLimitedUntil="2026-08-10T12:01:00.000Z" />),
    ).toContain("Paused until 2026-08-10T12:01:00.000Z");
    expect(
      render(
        <ProviderAccountHealth
          usageLimitedUntil="2026-08-10T11:59:00.000Z"
          usageLimitCooldownSeconds={30}
          lastUsageLimitedAt="earlier"
        />,
      ),
    ).toContain("Cooldown: 30s · last limit earlier");
    expect(render(<ProviderAccountHealth usageLimitCooldownSeconds={0} />)).toContain(
      "Cooldown: 0s",
    );
    expect(render(<ProviderAccountHealth />)).toContain("Available");
  });

  it("renders execution argv, errors, and resume fallback notices by presence", () => {
    expect(render(<SessionExecutionSummary status="queued" resolvedArgv={[]} />)).not.toContain(
      "Resolved argv",
    );
    const markup = render(
      <SessionExecutionSummary
        status="failed"
        resolvedArgv={["run", "--fast"]}
        errorCode="E_RUN"
        errorMessage="Could not run"
        resumeFallback
        resumedFromSessionId="old-session"
      />,
    );
    expect(markup).toContain("run --fast");
    expect(markup).toContain("E_RUN:");
    expect(markup).toContain("Could not run");
    expect(markup).toContain("Resumed from old-session.");
    expect(render(<SessionExecutionSummary status="failed" errorMessage="Failed" />)).toContain(
      ">Failed</div>",
    );
    const codeOnly = render(<SessionExecutionSummary status="failed" errorCode="queue_expired" />);
    expect(codeOnly).toContain('role="alert"');
    expect(codeOnly).toContain("queue_expired");
    expect(codeOnly).toContain("Session ended with this error code.");
    expect(
      render(<SessionExecutionSummary status="queued" errorCode="usage_limit" />),
    ).not.toContain("session-detail-error");
    expect(
      render(
        <SessionExecutionSummary
          status="queued"
          errorCode="usage_limit"
          errorMessage="Provider limit; retry pending"
        />,
      ),
    ).toContain('role="status"');
    expect(render(<SessionExecutionSummary status="completed" />)).not.toContain(
      "session-detail-error",
    );
    expect(render(<SessionExecutionSummary status="queued" resumeFallback />)).toContain(
      "fresh attempt",
    );
  });

  it("renders route labels, fallback sources, and resolution precedence", () => {
    const complete = render(
      <SessionRouteSummary
        session={{
          targetLabel: "primary",
          targetLabels: ["primary", "backup"],
          fallbacks: [{ providerId: "ignored" }],
          resolvedProviderAccountId: "account",
          resolvedCommandId: "command",
          resolvedHostId: "host",
          resolvedRoute: { targetIndex: 1, worktreeId: "route-worktree" },
          worktreeId: "fallback-worktree",
        }}
      />,
    );
    expect(complete).toContain("Fallbacks: backup");
    expect(complete).toContain("target 2");
    expect(complete).toContain("account: account");
    expect(complete).toContain("command: command");
    expect(complete).toContain("host: host");
    expect(complete).toContain("worktree: route-worktree");
    expect(
      render(
        <SessionRouteSummary
          session={{
            targetLabels: [],
            target: { providerId: "p" },
            fallbacks: [{ commandId: "c" }],
            resolvedRoute: { providerAccountId: "a", commandId: "c", hostId: "h" },
            hostId: "fallback-host",
            worktreeId: "fallback-worktree",
          }}
        />,
      ),
    ).toContain("Fallbacks: command:c");
    expect(render(<SessionRouteSummary session={{ fallbacks: [{}] }} />)).toContain("Fallbacks: —");
    const cli = render(<SessionRouteSummary session={{}} />);
    expect(cli).toContain("Target");
    expect(cli).toContain("—");
    expect(cli).toContain("account: CLI");
    expect(cli).toContain("host: CLI");
  });
});
