import type { Metadata } from "next";
import "@auto-harness/ui/globals.css";
import { THEME_INIT_SCRIPT } from "@auto-harness/ui";

import { HostShell } from "../components/host-shell.tsx";
import { hostId, apiGet } from "../lib/api.ts";

export const metadata: Metadata = {
  title: "Auto Harness — Host pane",
  description: "Per-host inventory and status",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const id = hostId();
  let online: boolean | undefined;
  try {
    const agents = await apiGet<{ items: Array<{ hostId: string; online: boolean }> }>(
      "/api/v1/hosts",
    );
    online = agents.items?.find((a) => a.hostId === id)?.online;
  } catch {
    /* leave undefined — the header renders no badge rather than throwing */
  }

  return (
    <html lang="en">
      <body>
        {/* Runs before paint so the stored/system theme is applied before hydration — without
            this, every page load flashes light before React could catch up. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HostShell hostId={id} online={online}>
          {children}
        </HostShell>
      </body>
    </html>
  );
}
