"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { cn } from "../lib/utils.ts";
import { Button } from "./button.tsx";

type ToastVariant = "default" | "destructive";

type ShowToastOptions = {
  variant?: ToastVariant;
  /** Overrides `data-pw="toast"` so form tests/e2e can keep their existing error ids. */
  pw?: string;
};

type ToastState = { message: string; variant: ToastVariant; pw?: string };

let clientToast: ToastState | null = null;
const listeners = new Set<() => void>();

function emit(next: ToastState | null): void {
  clientToast = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getClientToast(): ToastState | null {
  return clientToast;
}

/** Show a toast without navigating. `withToast` remains the URL/redirect path. */
export function showToast(message: string, options: ShowToastOptions = {}): void {
  if (!message) {
    emit(null);
    return;
  }
  emit({
    message,
    variant: options.variant === "destructive" ? "destructive" : "default",
    ...(options.pw !== undefined ? { pw: options.pw } : {}),
  });
}

export function dismissToast(): void {
  emit(null);
}

/**
 * Shows a one-off success message carried across a redirect via a `?toast=`
 * query param (e.g. after creating something, before navigating to its
 * detail page) — survives the navigation without any client-side state
 * provider, and strips itself from the URL once shown.
 *
 * Client-side callers (form submit failures) use `showToast` instead of the
 * URL param so the error does not dump raw JSON under the field.
 */
export function Toast({ paramName = "toast" }: { paramName?: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const param = searchParams.get(paramName);
  const [urlMessage, setUrlMessage] = useState<string | null>(null);
  const live = useSyncExternalStore(subscribe, getClientToast, () => null);

  // Capture the incoming param into local state and strip it from the URL.
  // Runs once per incoming param value, not per `message` state change.
  useEffect(() => {
    if (!param) {
      return;
    }
    dismissToast();
    setUrlMessage(param);
    const params = new URLSearchParams(searchParams);
    params.delete(paramName);
    const next = params.size ? `${pathname}?${params.toString()}` : pathname;
    // The content is already correct. Update only the address bar so cleanup
    // cannot race the navigation that rendered this toast.
    history.replaceState(history.state, "", next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [param]);

  const displayed =
    live ?? (urlMessage ? { message: urlMessage, variant: "default" as const } : null);
  const displayedKey = displayed
    ? `${displayed.variant}:${displayed.pw ?? ""}:${displayed.message}`
    : "";

  // Auto-hide, independent of the URL-stripping effect above so the
  // resulting searchParams/router churn can't cancel this timer early.
  useEffect(() => {
    if (!displayedKey) {
      return;
    }
    const hide = setTimeout(() => {
      dismissToast();
      setUrlMessage(null);
    }, 4000);
    return () => clearTimeout(hide);
  }, [displayedKey]);

  if (!displayed) {
    return null;
  }

  const destructive = displayed.variant === "destructive";
  return (
    <div
      role={destructive ? "alert" : "status"}
      data-pw={displayed.pw ?? "toast"}
      className={cn(
        "fixed bottom-4 right-4 z-50 max-w-sm rounded-md border px-4 py-2 text-sm shadow-lg",
        destructive
          ? "border-destructive bg-destructive text-destructive-foreground"
          : "border-border bg-foreground text-background",
      )}
    >
      {displayed.message}
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
