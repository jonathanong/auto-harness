import type { Metadata } from "next";
import "@auto-harness/ui/globals.css";

import { HostShell } from "../components/host-shell.tsx";
import { agentId } from "../lib/api.ts";

export const metadata: Metadata = {
  title: "Auto Harness — Host pane",
  description: "Per-host inventory and status",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <HostShell agentId={agentId()}>{children}</HostShell>
      </body>
    </html>
  );
}
