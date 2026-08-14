import type { Metadata } from "next";
import "@auto-harness/ui/globals.css";
import "@xterm/xterm/css/xterm.css";

import { ControlShell } from "../components/control-shell.tsx";

export const metadata: Metadata = {
  title: "Auto Harness — Control plane",
  description: "Control plane UI for sessions, repositories, schedules, and agents",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ControlShell>{children}</ControlShell>
      </body>
    </html>
  );
}
