"use client";

import type { ReactNode } from "react";
import { useState } from "react";

import { DetailHeader, type Crumb } from "./detail-header.tsx";
import { persistSessionDetailTab, resolveSessionDetailTab } from "./session-detail-tab.ts";
import type { SessionSummary } from "./session-detail-types.ts";
import { SessionDetailsCard } from "./session-details-card.tsx";
import { SessionExecutionSummary } from "./session-execution-summary.tsx";
import { SessionIdCopyButton } from "./session-id-copy-button.tsx";
import { SessionPromptPanel } from "./session-prompt-panel.tsx";
import { SessionStatusBar } from "./session-status-bar.tsx";
import { TabContent, TabList, TabPanels, TabTrigger } from "./tab-panels.tsx";

export type { SessionSummary } from "./session-detail-types.ts";

export type SessionDetailProps = {
  session: SessionSummary;
  breadcrumbs: Crumb[];
  /** Rendered in a row under the title (e.g. cancel/resume/archive buttons). */
  actions?: ReactNode;
  /** Logs tab body. */
  children?: ReactNode;
  /** Extra details-tab content (e.g. session usage). */
  detailsExtra?: ReactNode;
  /** Always-visible notices above the tabs (offline host, refresh paused). */
  notices?: ReactNode;
  /** Initial tab from `?tab=`; unknown values fall back to logs. */
  defaultTab?: string | undefined;
  /** When set, the repository field links to `${repoHrefBase}/${encodeURIComponent(repositoryId)}`. */
  repoHrefBase?: string;
  /** When set, the host field links to `${hostHrefBase}/${encodeURIComponent(hostId)}` (control plane only — the host pane has no per-host route). */
  hostHrefBase?: string;
  /** When set, the worktree field links to `${worktreeHrefBase}/${encodeURIComponent(worktreeId)}`. */
  worktreeHrefBase?: string;
};

/** Shared session detail view — reused by the host pane and control page. */
export function SessionDetail({
  session: s,
  breadcrumbs,
  actions,
  children,
  detailsExtra,
  notices,
  defaultTab,
  repoHrefBase,
  hostHrefBase,
  worktreeHrefBase,
}: SessionDetailProps) {
  const [tab, setTab] = useState(() => resolveSessionDetailTab(defaultTab));
  return (
    <div className="space-y-6" data-pw="session-detail">
      <DetailHeader
        breadcrumbs={breadcrumbs}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="font-mono" data-pw="session-detail-id">
              {s.id}
            </span>
            <SessionIdCopyButton sessionId={s.id} />
          </span>
        }
        actions={actions}
      />

      <SessionStatusBar session={s} />
      {notices}
      <SessionExecutionSummary
        status={s.status}
        errorCode={s.errorCode}
        errorMessage={s.errorMessage}
        resumeFallback={s.resumeFallback}
        resumedFromSessionId={s.resumedFromSessionId}
      />

      <TabPanels
        value={tab}
        onValueChange={(value) => {
          const next = resolveSessionDetailTab(value);
          setTab(next);
          persistSessionDetailTab(next);
        }}
        data-pw="session-detail-tabs"
      >
        <TabList>
          <TabTrigger value="logs">Logs</TabTrigger>
          <TabTrigger value="details">Details</TabTrigger>
          <TabTrigger value="prompts">Prompts</TabTrigger>
        </TabList>
        <TabContent value="logs" forceMount data-pw="session-tab-logs">
          {children}
        </TabContent>
        <TabContent value="details" data-pw="session-tab-details">
          <SessionDetailsCard
            session={s}
            detailsExtra={detailsExtra}
            repoHrefBase={repoHrefBase}
            hostHrefBase={hostHrefBase}
            worktreeHrefBase={worktreeHrefBase}
          />
        </TabContent>
        <TabContent value="prompts" data-pw="session-tab-prompts">
          <SessionPromptPanel prompt={s.prompt} resolvedArgv={s.resolvedArgv} />
        </TabContent>
      </TabPanels>
    </div>
  );
}
