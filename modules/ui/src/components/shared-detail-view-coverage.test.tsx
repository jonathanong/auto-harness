import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RepositoryDetail, RepositoryDetailsCard } from "./repository-detail.tsx";
import { SessionDetail } from "./session-detail.tsx";
import { WorktreeDetail, WorktreeDetailsCard } from "./worktree-detail.tsx";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(node);
}

const worktree = {
  id: "worktree/a",
  name: "feature-a",
  repositoryId: "repo/a",
  path: "/worktrees/a",
  status: "running",
  online: true,
  hostId: "host/a",
  labels: ["fast", "linux"],
};

describe("shared detail views", () => {
  it("renders repository headers, actions, children, and each settings fallback", () => {
    const detail = render(
      <RepositoryDetail
        repository={{ id: "repo/a", name: "Repository A" }}
        breadcrumbs={[{ label: "Repositories", href: "/repositories" }, { label: "Repository A" }]}
        actions={<button type="button">Remove repository</button>}
      >
        <p>Repository sessions</p>
      </RepositoryDetail>,
    );
    expect(detail).toContain('data-pw="repository-detail"');
    expect(detail).toContain('data-pw="repository-detail-id"');
    expect(detail).toContain("Remove repository");
    expect(detail).toContain("Repository sessions");
    expect(render(<RepositoryDetail repository={{ id: "repo/id" }} breadcrumbs={[]} />)).toContain(
      "repo/id",
    );

    const full = render(
      <RepositoryDetailsCard
        repository={{
          id: "repo/a",
          path: "/repos/a",
          url: "https://ignored.example/a",
          defaultBranch: "trunk",
          setupScript: "pnpm install",
          terminalHookScript: "echo ready",
        }}
      />,
    );
    expect(full).toContain('data-pw="repository-detail-path"');
    expect(full).toContain("/repos/a");
    expect(full).toContain("trunk");
    expect(full).toContain("pnpm install");
    expect(full).toContain("echo ready");
    const url = render(
      <RepositoryDetailsCard repository={{ id: "repo/b", url: "https://repo.test/b" }} />,
    );
    expect(url).toContain("https://repo.test/b");
    expect(render(<RepositoryDetailsCard repository={{ id: "repo/c" }} />)).toContain("main");
  });

  it("renders linked, plain, and absent session relationships with full details", () => {
    const linked = render(
      <SessionDetail
        session={{
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
          resolvedArgv: ["agent", "run"],
          errorCode: "E_RETRY",
          errorMessage: "Retrying",
          resumeFallback: true,
          resumedFromSessionId: "session/old",
        }}
        breadcrumbs={[{ label: "Sessions", href: "/sessions" }, { label: "session/a" }]}
        actions={<button type="button">Cancel</button>}
        repoHrefBase="/repositories"
        hostHrefBase="/hosts"
        worktreeHrefBase="/worktrees"
      >
        <section aria-label="Session logs">Logs</section>
      </SessionDetail>,
    );
    expect(linked).toContain('data-pw="session-detail-status"');
    expect(linked).toContain('data-pw="session-detail-source"');
    expect(linked).toContain('data-pw="session-source-api"');
    expect(linked).toContain('href="/repositories/repo%2Fa"');
    expect(linked).toContain('href="/hosts/host%2Fa"');
    expect(linked).toContain('href="/worktrees/worktree%2Fa"');
    expect(linked).toContain('data-pw="session-detail-worktree"');
    expect(linked).toContain("30s");
    expect(linked).toContain('data-pw="session-detail-priority">0');
    expect(linked).toContain("agent run");
    expect(linked).toContain('data-pw="session-detail-prompt"');
    expect(linked).toContain('data-pw="session-detail-prompt-content" tabindex="0"');
    expect(linked).toContain("Ship it");
    expect(linked).toContain('aria-label="Session logs"');
    expect(linked).toContain("Cancel");

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
      />,
    );
    expect(plain).toContain("repo/b");
    expect(plain).toContain('data-pw="session-source-unknown"');
    expect(plain).toContain("host/b");
    expect(plain).toContain("worktree/b");
    expect(plain).toContain('data-pw="session-detail-queue-deadline"');
    expect(plain).toContain('dateTime="2026-08-14T12:30:00.000Z"');
    expect(plain).toContain('data-pw="session-detail-priority">—');
    expect(plain).toContain('Timeout</dt><dd class="text-sm" data-pw="session-detail-timeout">—');
    const absent = render(
      <SessionDetail session={{ id: "session/c", status: "queued" }} breadcrumbs={[]} />,
    );
    expect(absent).toContain('Repository</dt><dd class="font-mono text-sm">—');
    expect(absent).toContain('id="session-detail-prompt-heading"');
    expect(absent).toContain('data-pw="session-detail-prompt-content" tabindex="0">—</pre>');
    expect(absent).toContain('data-pw="session-detail-worktree">—');
    expect(
      render(
        <SessionDetail
          session={{ id: "scheduled", type: "scheduled", status: "queued" }}
          breadcrumbs={[]}
        />,
      ),
    ).toContain('data-pw="session-detail-worktree">Main checkout');
  });

  it("renders worktree headers and settings links, optional fields, and fallbacks", () => {
    const detail = render(
      <WorktreeDetail
        worktree={worktree}
        breadcrumbs={[]}
        actions={<button type="button">Remove</button>}
      >
        <p>Worktree sessions</p>
      </WorktreeDetail>,
    );
    expect(detail).toContain('data-pw="worktree-detail"');
    expect(detail).toContain("Remove");
    expect(detail).toContain("Worktree sessions");
    const linked = render(
      <WorktreeDetailsCard
        worktree={worktree}
        repositoryName="Repository A"
        repoHrefBase="/repositories"
        repoPath="/repos/a"
        hostHrefBase="/hosts"
      />,
    );
    expect(linked).toContain('href="/repositories/repo%2Fa"');
    expect(linked).toContain('href="/hosts/host%2Fa"');
    expect(linked).toContain("/repos/a");
    expect(linked).toContain("Scheduler label: fast");
    expect(linked).toContain("Scheduler label: linux");
    expect(linked).toContain('data-pw="worktree-detail-path"');
    expect(linked).toContain('data-pw="worktree-detail-online">Online');
    const plain = render(
      <WorktreeDetailsCard
        worktree={{ id: "worktree/b", name: "b", repositoryId: "repo/b", path: "/b" }}
      />,
    );
    expect(plain).toContain("repo/b");
    expect(plain).toContain("Status</dt><dd>—");
    expect(plain).toContain("Online</dt><dd>—");
    expect(plain).toContain('data-pw="worktree-labels-worktree/b">—');
    const fallback = render(
      <WorktreeDetailsCard worktree={worktree} repoHrefBase="/repositories" />,
    );
    expect(fallback).toContain("repo/a");
    const changingLabels = { ...worktree };
    let labelsRead = 0;
    Object.defineProperty(changingLabels, "labels", {
      enumerable: true,
      get: () => (++labelsRead === 1 ? ["first-read"] : undefined),
    });
    expect(render(<WorktreeDetailsCard worktree={changingLabels} />)).toContain("first-read");
    expect(labelsRead).toBe(1);
  });
});
