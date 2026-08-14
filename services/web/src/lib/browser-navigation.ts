/** Perform an authoritative browser navigation after a committed mutation. */
export function navigateBrowser(
  href: string,
  assign: (target: string) => void = location.assign.bind(location),
): void {
  assign(href);
}
