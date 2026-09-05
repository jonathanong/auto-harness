import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionDetail } from "./session-detail.tsx";
import { SESSION_QUEUED_WAIT_COPY } from "./session-status-cell.tsx";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(node);
}

describe("SessionDetail static markup", () => {
  it("renders linked, plain, and absent session relationships with full details", () => {
    const linkedSession = {
      id: "session/a",
      status: "running",
      repositoryId: "repo/a",
      hostId: "host/a",
      worktreeId: "worktree/a",
      ref: "main",
      source: "api",
      concurrencyId: "lock-a",
      timeout: 30,
      createdAt: "created",
      startedAt: "started",
      completedAt: "completed",
      exitCode: 0,
      prompt: "Ship it",
      priority: 0,
      targetDisplayNames: ["codex — codex-exec"],
      resolvedArgv: ["agent", "run"],
      errorCode: "E_RETRY",
      errorMessage: "Retrying",
      resumeFallback: true,
      resumedFromSessionId: "session/old",
    };
    const linked = render(
      <SessionDetail
        session={linkedSession}
        breadcrumbs={[{ label: "Sessions", href: "/sessions" }, { label: "session/a" }]}
        actions={<button type="button">Cancel</button>}
        notices={<p data-pw="session-notice">Notice</p>}
        detailsExtra={<p data-pw="session-usage-summary">Usage</p>}
        repoHrefBase="/repositories"
        hostHrefBase="/hosts"
        worktreeHrefBase="/worktrees"
      >
        <section aria-label="Session logs">Logs</section>
      </SessionDetail>,
    );
    expect(linked).toContain('data-pw="session-detail-status"');
    expect(linked).not.toContain(SESSION_QUEUED_WAIT_COPY);
    expect(linked).toContain('data-pw="session-detail-source"');
    expect(linked).toContain('data-pw="session-source-api"');
    expect(linked).toContain('data-pw="session-status-bar-provider"');
    expect(linked).toContain("codex — codex-exec");
    expect(linked).toContain('aria-label="Session logs"');
    expect(linked).toContain("Cancel");
    expect(linked).toContain('data-pw="session-notice"');
    expect(linked).toContain("Retrying");
    expect(linked).not.toContain('data-pw="session-detail-priority"');

    const details = render(
      <SessionDetail
        session={linkedSession}
        breadcrumbs={[]}
        defaultTab="details"
        detailsExtra={<p data-pw="session-usage-summary">Usage</p>}
        repoHrefBase="/repositories"
        hostHrefBase="/hosts"
        worktreeHrefBase="/worktrees"
      />,
    );
    expect(details).toContain('href="/repositories/repo%2Fa"');
    expect(details).toContain('href="/hosts/host%2Fa"');
    expect(details).toContain('href="/worktrees/worktree%2Fa"');
    expect(details).toContain('data-pw="session-detail-worktree"');
    expect(details).toContain("30s");
    expect(details).toContain('data-pw="session-detail-priority">0');
    expect(details).toContain('data-pw="session-usage-summary"');

    const prompts = render(
      <SessionDetail session={linkedSession} breadcrumbs={[]} defaultTab="prompts" />,
    );
    expect(prompts).toContain('aria-label="agent run"');
    expect(prompts).toContain('data-pw="session-detail-prompt"');
    expect(prompts).toContain('data-pw="session-detail-prompt-content" tabindex="0"');
    expect(prompts).toContain("Ship it");

    const plain = render(
      <SessionDetail
        session={{
          id: "session/b",
          status: "queued",
          queueExpiresAt: "2026-08-14T12:30:00.000Z",
          repositoryId: "repo/b",
          hostId: "host/b",
          worktreeId: "worktree/b",
        }}
        breadcrumbs={[]}
        defaultTab="details"
      />,
    );
    expect(plain).toContain("repo/b");
    expect(plain).toContain('data-pw="session-source-unknown"');
    expect(plain).toContain("host/b");
    expect(plain).toContain("worktree/b");
    expect(plain).toContain(SESSION_QUEUED_WAIT_COPY);
    expect(plain).toContain('data-pw="session-detail-priority">—');
    expect(plain).toContain('Timeout</dt><dd class="text-sm" data-pw="session-detail-timeout">—');
    const queuedBar = render(
      <SessionDetail
        session={{
          id: "session/b",
          status: "queued",
          queueExpiresAt: "2026-08-14T12:30:00.000Z",
          repositoryId: "repo/b",
        }}
        breadcrumbs={[]}
      />,
    );
    expect(queuedBar).toContain('data-pw="session-detail-queue-deadline"');
    expect(queuedBar).toContain('dateTime="2026-08-14T12:30:00.000Z"');
    const absent = render(
      <SessionDetail
        session={{ id: "session/c", status: "queued" }}
        breadcrumbs={[]}
        defaultTab="details"
      />,
    );
    expect(absent).toContain('Repository</dt><dd class="font-mono text-sm">—');
    expect(absent).toContain('data-pw="session-detail-worktree">—');
    const absentPrompt = render(
      <SessionDetail
        session={{ id: "session/c", status: "queued" }}
        breadcrumbs={[]}
        defaultTab="prompts"
      />,
    );
    expect(absentPrompt).toContain('id="session-detail-prompt-heading"');
    expect(absentPrompt).toContain('data-pw="session-detail-prompt-content" tabindex="0">—</pre>');
    expect(
      render(
        <SessionDetail
          session={{ id: "scheduled", type: "scheduled", status: "queued" }}
          breadcrumbs={[]}
          defaultTab="details"
        />,
      ),
    ).toContain('data-pw="session-detail-worktree">Main checkout');
  });
});
