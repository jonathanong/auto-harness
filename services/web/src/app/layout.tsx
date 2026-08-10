import type { Metadata } from "next";
import { Suspense } from "react";
import "@auto-harness/ui/globals.css";
import { Toast } from "@auto-harness/ui";

import { ControlShell } from "../components/control-shell.tsx";

export const metadata: Metadata = {
  title: "Auto Harness — Control plane",
  description: "Control plane UI for sessions, repositories, schedules, and agents",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ControlShell>
          {children}
          <Suspense>
            <Toast />
          </Suspense>
        </ControlShell>
      </body>
    </html>
  );
}
