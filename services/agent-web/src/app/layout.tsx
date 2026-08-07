import type { Metadata } from "next";
import "@auto-harness/ui/globals.css";

import { HostShell } from "../components/host-shell.tsx";
import { agentId, apiGet } from "../lib/api.ts";

export const metadata: Metadata = {
  title: "Auto Harness — Host pane",
  description: "Per-host inventory and status",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const id = agentId();
  let online: boolean | undefined;
  try {
    const agents = await apiGet<{ items: Array<{ agentId: string; online: boolean }> }>(
      "/api/v1/agents",
    );
    online = agents.items?.find((a) => a.agentId === id)?.online;
  } catch {
    /* leave undefined — the header renders no badge rather than throwing */
  }

  return (
    <html lang="en">
      <body>
        <HostShell agentId={id} online={online}>
          {children}
        </HostShell>
      </body>
    </html>
  );
}
