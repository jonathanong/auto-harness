import type { Metadata } from "next";
import "@auto-harness/ui/globals.css";
import { Alert, THEME_INIT_SCRIPT } from "@auto-harness/ui";

import { HostShell } from "../components/host-shell.tsx";
import { apiGet, hostId, isUnauthenticatedError } from "../lib/api.ts";
import {
  HOST_PANE_UNAUTHENTICATED_BODY,
  HOST_PANE_UNAUTHENTICATED_HEADING,
} from "../lib/unauthenticated.ts";

export const metadata: Metadata = {
  title: "Auto Harness — Host pane",
  description: "Debug-only per-host UI. Operators should use the control plane.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const id = hostId();
  let online: boolean | undefined;
  let unauthenticated = false;
  try {
    const agents = await apiGet<{ items: Array<{ hostId: string; online: boolean }> }>(
      "/api/v1/hosts",
    );
    online = agents.items?.find((a) => a.hostId === id)?.online;
  } catch (err) {
    // Remote WebUrl 401s are not a missing online badge — this pane has no login.
    unauthenticated = isUnauthenticatedError(err);
  }

  return (
    <html lang="en">
      <body>
        {/* Runs before paint so the stored/system theme is applied before hydration — without
            this, every page load flashes light before React could catch up. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {unauthenticated ? (
          <div className="mx-auto max-w-xl px-4 py-16">
            <Alert variant="warning" role="alert">
              <p className="font-medium">{HOST_PANE_UNAUTHENTICATED_HEADING}</p>
              <p className="mt-1">{HOST_PANE_UNAUTHENTICATED_BODY}</p>
            </Alert>
          </div>
        ) : (
          <HostShell hostId={id} online={online}>
            {children}
          </HostShell>
        )}
      </body>
    </html>
  );
}
