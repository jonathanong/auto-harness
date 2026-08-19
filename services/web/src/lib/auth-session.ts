export { SESSION_COOKIE, hasValidSession } from "@auto-harness/shared";

/** Permit only an in-app absolute path as a post-login destination. */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/";
  }
  return value;
}

export function loginPath(returnTo: string): string {
  return `/login?${new URLSearchParams({ returnTo: safeReturnPath(returnTo) }).toString()}`;
}

/** Full navigation after login so CloudFront/App Router cannot leave "Signing in…" stuck. */
export function navigateAfterLogin(
  returnTo: string | null | undefined,
  assign: (href: string) => void = (href) => {
    globalThis.location.assign(href);
  },
): void {
  assign(safeReturnPath(returnTo));
}
