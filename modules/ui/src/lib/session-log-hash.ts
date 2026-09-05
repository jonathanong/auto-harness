export function parseLogLineHash(hash: string): number | undefined {
  const match = /^#L(\d+)$/.exec(hash);
  if (!match) return undefined;
  const line = Number(match[1]);
  return line > 0 ? line : undefined;
}

export function logLineHash(line: number): string {
  return `#L${line}`;
}

export function replaceLogLineHash(line: number): string {
  const hash = logLineHash(line);
  const url = `${location.pathname}${location.search}${hash}`;
  history.replaceState(null, "", url);
  return location.href;
}
