import type { Metadata } from "next";
import "@auto-harness/ui/globals.css";
import "@xterm/xterm/css/xterm.css";
import { THEME_INIT_SCRIPT } from "@auto-harness/ui";

import { ControlShell } from "../components/control-shell.tsx";

export const metadata: Metadata = {
  title: "Auto Harness — Control plane",
  description: "Control plane UI for sessions, repositories, schedules, and agents",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Runs before paint so the stored/system theme is applied before hydration — without
            this, every page load flashes light before React could catch up. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <ControlShell>{children}</ControlShell>
      </body>
    </html>
  );
}
