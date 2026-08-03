import type { Metadata } from "next";
import "@auto-harness/ui/globals.css";

import { AgentShell } from "../components/agent-shell.tsx";

export const metadata: Metadata = {
  title: "Auto Harness — Agent pane",
  description: "Per-agent host inventory and status",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const agentId =
    process.env.HARNESS_AGENT_ID ?? process.env.NEXT_PUBLIC_HARNESS_AGENT_ID ?? "local-1";
  return (
    <html lang="en">
      <body>
        <AgentShell agentId={agentId}>{children}</AgentShell>
      </body>
    </html>
  );
}
