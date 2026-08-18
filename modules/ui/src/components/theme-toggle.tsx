"use client";

import { useEffect, useState } from "react";

import { Button } from "./button.tsx";

const STORAGE_KEY = "harness-theme";

/** Dispatched on `window` whenever the `dark` class changes, so anything reading a computed
 * CSS variable (the xterm terminal) can rebuild its own colors instead of staying stale. */
export const THEME_CHANGE_EVENT = "harness:theme-change";

/**
 * Blocking, pre-hydration script — inline it as the first child of `<body>` in each app's root
 * layout. Runs before paint so the correct theme is already applied when content first renders;
 * without it, every page load flashes light before a `useEffect` could catch up.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var s=window.localStorage.getItem("${STORAGE_KEY}");var d=s==="dark"||(s!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;

function setDark(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark);
  window.localStorage.setItem(STORAGE_KEY, dark ? "dark" : "light");
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}

/**
 * Reads the applied class rather than owning theme state itself — THEME_INIT_SCRIPT (or a prior
 * toggle click) is always the source of truth for what's on <html> right now. Renders nothing
 * until mounted: the server always renders "light" (no localStorage access), so painting a real
 * icon before hydration risks a mismatch against whatever the init script already applied.
 */
export function ThemeToggle() {
  const [dark, setDarkState] = useState<boolean | null>(null);
  useEffect(() => {
    setDarkState(document.documentElement.classList.contains("dark"));
  }, []);
  if (dark === null) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-pw="theme-toggle"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => {
        setDark(!dark);
        setDarkState(!dark);
      }}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}
