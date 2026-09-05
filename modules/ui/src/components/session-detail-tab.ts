const SESSION_DETAIL_TABS = ["logs", "details", "prompts"] as const;

export type SessionDetailTab = (typeof SESSION_DETAIL_TABS)[number];

const TAB_SET = new Set<string>(SESSION_DETAIL_TABS);

/** Coerce a URL `?tab=` value (including Next's string[] form) to a known session tab. */
export function resolveSessionDetailTab(tab: unknown): SessionDetailTab {
  const value = Array.isArray(tab) ? tab[0] : tab;
  return typeof value === "string" && TAB_SET.has(value) ? (value as SessionDetailTab) : "logs";
}

/** Update `?tab=` without a Next navigation so the live log island is not remounted. */
export function persistSessionDetailTab(tab: SessionDetailTab): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (tab === "logs") url.searchParams.delete("tab");
  else url.searchParams.set("tab", tab);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
