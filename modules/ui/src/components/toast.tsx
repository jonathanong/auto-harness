"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { Button } from "./button.tsx";

/**
 * Shows a one-off success message carried across a redirect via a `?toast=`
 * query param (e.g. after creating something, before navigating to its
 * detail page) — survives the navigation without any client-side state
 * provider, and strips itself from the URL once shown.
 */
export function Toast({ paramName = "toast" }: { paramName?: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const param = searchParams.get(paramName);
  const [message, setMessage] = useState<string | null>(null);

  // Capture the incoming param into local state and strip it from the URL.
  // Runs once per incoming param value, not per `message` state change.
  useEffect(() => {
    if (!param) {
      return;
    }
    setMessage(param);
    const params = new URLSearchParams(searchParams);
    params.delete(paramName);
    const next = params.size ? `${pathname}?${params.toString()}` : pathname;
    // The content is already correct. Update only the address bar so cleanup
    // cannot race the navigation that rendered this toast.
    history.replaceState(history.state, "", next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [param]);

  // Auto-hide, independent of the URL-stripping effect above so the
  // resulting searchParams/router churn can't cancel this timer early.
  useEffect(() => {
    if (!message) {
      return;
    }
    const hide = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(hide);
  }, [message]);

  if (!message) {
    return null;
  }

  return (
    <div
      role="status"
      data-pw="toast"
      className="fixed bottom-4 right-4 z-50 rounded-md border border-border bg-foreground px-4 py-2 text-sm text-background shadow-lg"
    >
      {message}
    </div>
  );
}

/** Persistent mutation failure notification with an explicit retry action. */
export function RetryToast({
  children,
  onRetry,
  pending = false,
}: {
  children: ReactNode;
  onRetry: () => void;
  pending?: boolean;
}) {
  return (
    <div
      role="alert"
      aria-atomic="true"
      data-pw="mutation-error-toast"
      className="fixed bottom-4 right-4 z-50 max-w-sm rounded-md border border-destructive/40 bg-background p-4 text-sm text-foreground shadow-lg"
    >
      <div>{children}</div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3"
        disabled={pending}
        onClick={onRetry}
        data-pw="mutation-error-retry"
      >
        {pending ? "Retrying…" : "Try again"}
      </Button>
    </div>
  );
}

/** Build an href that shows `message` as a toast once the target page loads. */
export function withToast(href: string, message: string): string {
  const url = new URL(href, "http://placeholder.invalid");
  url.searchParams.set("toast", message);
  return `${url.pathname}${url.search}`;
}
