import type { Metadata } from "next";
import { headers } from "next/headers";
import "@auto-harness/ui/globals.css";
import { THEME_INIT_SCRIPT } from "@auto-harness/ui";
import { optionalSentryDsn } from "@auto-harness/shared";

import { ControlShell } from "../components/control-shell.tsx";
import { SentryClientInit } from "../components/sentry-client-init.tsx";
import { can, loadPrincipal } from "../lib/principal.ts";

export const metadata: Metadata = {
  title: "Auto Harness — Control plane",
  description: "Control plane UI for sessions, repositories, schedules, and agents",
};

export const dynamic = "force-dynamic";

async function layoutPathname(): Promise<string | null> {
  try {
    return (await headers()).get("x-pathname");
  } catch {
    return null;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = await layoutPathname();
  const principal = pathname === "/login" ? undefined : await loadPrincipal();
  const sentryDsn = optionalSentryDsn(process.env.HARNESS_WEB_SENTRY_DSN_CLIENT);
  return (
    <html lang="en">
      <body>
        {sentryDsn ? <SentryClientInit dsn={sentryDsn} plane="web" /> : null}
        {/* Runs before paint so the stored/system theme is applied before hydration — without
            this, every page load flashes light before React could catch up. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <ControlShell
          authRequired={process.env.HARNESS_AUTH_MODE === "required"}
          canAuthorSessions={can(principal, "sessions:write")}
        >
          {children}
        </ControlShell>
      </body>
    </html>
  );
}
