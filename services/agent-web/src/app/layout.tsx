import type { Metadata } from "next";
import "@auto-harness/ui/globals.css";

import { AgentShell } from "../components/agent-shell.tsx";
import { agentId } from "../lib/api.ts";

export const metadata: Metadata = {
  title: "Auto Harness — Agent pane",
  description: "Per-agent host inventory and status",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AgentShell agentId={agentId()}>{children}</AgentShell>
      </body>
    </html>
  );
}
