const BASE_SESSION_DETAIL_TABS = ["logs", "details", "prompts"] as const;

export type SessionDetailTab = (typeof BASE_SESSION_DETAIL_TABS)[number] | "outputs";

const TAB_SET = new Set<string>(BASE_SESSION_DETAIL_TABS);

/** Coerce a URL `?tab=` value (including Next's string[] form) to a known session tab. */
export function resolveSessionDetailTab(tab: unknown, outputsEnabled = false): SessionDetailTab {
  const value = Array.isArray(tab) ? tab[0] : tab;
  if (outputsEnabled && value === "outputs") return "outputs";
  return typeof value === "string" && TAB_SET.has(value) ? (value as SessionDetailTab) : "logs";
}

/** Update `?tab=` without a Next navigation so the live log island is not remounted. */
export function persistSessionDetailTab(tab: SessionDetailTab): void {
  const url = new URL(window.location.href);
  if (tab === "logs") url.searchParams.delete("tab");
  else url.searchParams.set("tab", tab);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
