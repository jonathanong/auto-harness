"use client";

import { useEffect, useState } from "react";

export function useSessionTableKeyboard(ids: string[], hrefBase?: string) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || hasCommandModifier(event)) return;
      if (
        isEditableTarget(event.target) ||
        document.querySelector('[role="dialog"][aria-modal="true"]')
      )
        return;
      const key = event.key.toLowerCase();
      if (key !== "j" && key !== "k" && key !== "enter") return;
      const selectedIndex = ids.indexOf(selectedId ?? "");
      if (key === "enter") {
        const selectedRow = findBySessionId<HTMLElement>("data-session-row-id", selectedId ?? "");
        if (selectedId && hrefBase && event.target === selectedRow) {
          event.preventDefault();
          findBySessionId<HTMLAnchorElement>("data-session-link-id", selectedId)?.click();
        }
        return;
      }
      if (ids.length === 0) return;
      event.preventDefault();
      const nextIndex =
        key === "j"
          ? Math.min(selectedIndex < 0 ? 0 : selectedIndex + 1, ids.length - 1)
          : Math.max(selectedIndex < 0 ? ids.length - 1 : selectedIndex - 1, 0);
      const nextId = ids[nextIndex] ?? null;
      setSelectedId(nextId);
      queueMicrotask(() => {
        const row = findBySessionId<HTMLElement>("data-session-row-id", nextId ?? "");
        row?.focus({ preventScroll: true });
        row?.scrollIntoView?.({ block: "nearest" });
      });
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [hrefBase, ids, selectedId]);

  return { selectedId, setSelectedId };
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

function findBySessionId<T extends HTMLElement>(attribute: string, id: string): T | undefined {
  return [...document.querySelectorAll<T>(`[${attribute}]`)].find(
    (element) => element.getAttribute(attribute) === id,
  );
}
