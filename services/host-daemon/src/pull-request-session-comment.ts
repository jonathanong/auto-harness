export function pullRequestNumberFromAssign(assign: {
  ref?: string;
  metadata?: Record<string, unknown>;
}): number | undefined {
  for (const candidate of [
    assign.metadata?.publishTargetPrNumber,
    assign.metadata?.githubPullRequestNumber,
  ]) {
    const parsed = positiveInteger(candidate);
    if (parsed !== undefined) return parsed;
  }
  const match = /^refs\/pull\/([1-9][0-9]*)\/head$/u.exec(assign.ref ?? "");
  return match ? positiveInteger(match[1]) : undefined;
}

export function githubRepositorySlug(
  remoteUrl: string,
): { owner: string; repo: string } | undefined {
  const trimmed = remoteUrl.trim();
  const match =
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(trimmed) ??
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(trimmed) ??
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(trimmed);
  if (!match?.[1] || !match[2]) return undefined;
  return { owner: match[1], repo: match[2] };
}

export function sessionCommentMarker(sessionId: string): string {
  return `<!-- auto-harness-session:${sessionId} -->`;
}

export function sessionCommentBody(sessionUrl: string, sessionId: string): string {
  return [
    "Auto Harness is running on this pull request.",
    "",
    `**Session:** ${sessionUrl}`,
    "",
    sessionCommentMarker(sessionId),
    "",
  ].join("\n");
}

export function positivePullRequestInteger(value: unknown): number | undefined {
  return positiveInteger(value);
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
