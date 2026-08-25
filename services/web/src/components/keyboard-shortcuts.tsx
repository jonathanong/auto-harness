"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@auto-harness/ui";

const prefixTimeoutMs = 1_500;
const navigationShortcuts = [
  ["d", "Dashboard", "/"],
  ["n", "New session", "/sessions/new"],
  ["s", "Sessions", "/sessions"],
  ["r", "Repositories", "/repositories"],
  ["w", "Worktrees", "/worktrees"],
  ["p", "Providers", "/providers"],
  ["c", "Commands", "/commands"],
  ["a", "Schedules", "/schedules"],
  ["h", "Hosts", "/hosts"],
  ["t", "Settings", "/settings"],
] as const;

const navigationByKey = new Map<string, string>(
  navigationShortcuts.map(([key, , href]) => [key, href]),
);

export function KeyboardShortcuts() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [waitingForDestination, setWaitingForDestination] = useState(false);
  const openRef = useRef(open);
  const waitingRef = useRef(waitingForDestination);
  const prefixTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);
  openRef.current = open;
  waitingRef.current = waitingForDestination;

  useEffect(() => {
    function clearPrefix() {
      if (prefixTimer.current) clearTimeout(prefixTimer.current);
      prefixTimer.current = undefined;
      waitingRef.current = false;
      setWaitingForDestination(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || hasCommandModifier(event)) return;
      if (isEditableTarget(event.target)) {
        if (event.key === "Escape" && event.target instanceof HTMLElement) event.target.blur();
        clearPrefix();
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "?" || (key === "/" && event.shiftKey)) {
        event.preventDefault();
        clearPrefix();
        setOpen(true);
        return;
      }
      if (openRef.current) return;
      if (waitingRef.current) {
        const href = navigationByKey.get(key);
        clearPrefix();
        if (href) {
          event.preventDefault();
          router.push(href);
        }
        return;
      }
      if (key === "n") {
        event.preventDefault();
        router.push("/sessions/new");
        return;
      }
      if (key === "s") {
        const search = document.querySelector<HTMLInputElement>('[data-pw="session-filter-q"]');
        if (search) {
          event.preventDefault();
          search.focus();
        }
        return;
      }
      if (key === "g") {
        event.preventDefault();
        waitingRef.current = true;
        setWaitingForDestination(true);
        prefixTimer.current = setTimeout(clearPrefix, prefixTimeoutMs);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (prefixTimer.current) clearTimeout(prefixTimer.current);
    };
  }, [router]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (prefixTimer.current) clearTimeout(prefixTimer.current);
        prefixTimer.current = undefined;
        waitingRef.current = false;
        setWaitingForDestination(false);
        setOpen(nextOpen);
        if (!nextOpen) queueMicrotask(() => triggerRef.current?.focus());
      }}
    >
      <DialogTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="sm"
          aria-keyshortcuts="?"
          data-pw="keyboard-shortcuts-trigger"
        >
          Shortcuts <kbd aria-hidden="true">?</kbd>
        </Button>
      </DialogTrigger>
      <DialogContent data-pw="keyboard-shortcuts-dialog">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts are disabled while you type in an input, select, or editable field.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <Shortcut keys="N" label="New session" pw="keyboard-shortcut-new-session" />
          <Shortcut keys="S" label="Focus session search" pw="keyboard-shortcut-search" />
          <Shortcut
            keys="J / K"
            label="Select next / previous session"
            pw="keyboard-shortcut-row"
          />
          <Shortcut keys="Enter" label="Open selected session" pw="keyboard-shortcut-open" />
          <Shortcut keys="?" label="Open this help" pw="keyboard-shortcut-help" />
          {navigationShortcuts.map(([key, label]) => (
            <Shortcut
              key={key}
              keys={`G ${key.toUpperCase()}`}
              label={`Go to ${label}`}
              pw={`keyboard-shortcut-go-${key}`}
            />
          ))}
          <Shortcut keys="Esc" label="Close this dialog" pw="keyboard-shortcut-close" />
        </dl>
      </DialogContent>
      <span className="sr-only" role="status" aria-live="polite" data-pw="shortcut-sequence-status">
        {waitingForDestination ? "Go to: choose a destination shortcut" : ""}
      </span>
    </Dialog>
  );
}

function Shortcut({ keys, label, pw }: { keys: string; label: string; pw: string }) {
  return (
    <div className="contents" data-pw={pw}>
      <dt>
        <kbd className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono">
          {keys}
        </kbd>
      </dt>
      <dd>{label}</dd>
    </div>
  );
}

function hasCommandModifier(event: KeyboardEvent): boolean {
  return event.altKey || event.ctrlKey || event.metaKey;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]',
    ),
  );
}
