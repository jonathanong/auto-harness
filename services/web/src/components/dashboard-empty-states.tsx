import type { ReactNode } from "react";
import Link from "next/link";

import { PrimaryEmptyState } from "./primary-empty-state.tsx";

export function DashboardEmptyStates({
  showHosts,
  showSessions,
}: {
  showHosts: boolean;
  showSessions: boolean;
}) {
  return (
    <>
      {showSessions ? (
        <PrimaryEmptyState title="Get started" pw="dashboard-empty-sessions">
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              <Action href="/repositories" pw="dashboard-empty-add-repository">
                Add a repository
              </Action>
            </li>
            <li>
              <Action href="/hosts" pw="dashboard-empty-connect-host">
                Connect a host
              </Action>
            </li>
            <li>
              <Action href="/sessions/new" pw="dashboard-empty-create-session">
                Create your first session
              </Action>
            </li>
          </ol>
        </PrimaryEmptyState>
      ) : null}

      {showHosts ? (
        <PrimaryEmptyState title="No hosts connected." pw="dashboard-empty-hosts">
          <p data-pw="dashboard-no-online-hosts">Connect a host daemon before sessions can run.</p>
          <Action href="/hosts" pw="dashboard-empty-setup-host">
            Set up a VPS host →
          </Action>
        </PrimaryEmptyState>
      ) : null}
    </>
  );
}

function Action({ href, pw, children }: { href: string; pw: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-medium text-primary hover:underline" data-pw={pw}>
      {children}
    </Link>
  );
}
