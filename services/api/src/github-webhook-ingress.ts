import type { TargetRef } from "@auto-harness/shared";

/** Immutable configuration that maps a GitHub numeric repository id to one session target. */
export type GitHubWebhookRepositoryBinding = Readonly<{
  githubRepositoryId: number;
  repositoryId: string;
  target: TargetRef;
  fallbacks?: readonly TargetRef[];
  /** Canonical branch ref used for issue comments that are not pull requests. */
  defaultRef: string;
  /** Explicit exceptions to GitHub's author-association gate. */
  allowedLogins?: readonly string[];
}>;

type GitHubWebhookSessionIntent = Readonly<{
  repositoryId: string;
  target: TargetRef;
  fallbacks?: TargetRef[];
  prompt: string;
  ref: string;
  concurrencyId: string;
  source: "webhook";
  metadata: Readonly<{
    githubEvent: "issue_comment" | "pull_request_review_comment";
    githubRepositoryId: number;
    githubCommentId: number;
    githubIssueNumber: number;
    githubPullRequestNumber: number | null;
    githubAuthorLogin: string;
  }>;
}>;

export type GitHubWebhookIngressResult =
  | { kind: "accepted"; session: GitHubWebhookSessionIntent }
  | {
      kind: "ignored";
      reason:
        | "unsupported_event"
        | "unsupported_action"
        | "unconfigured_repository"
        | "unauthorized_author"
        | "missing_mention"
        | "invalid_payload";
    };

type SupportedEvent = "issue_comment" | "pull_request_review_comment";

const MENTION = "@auto-harness";
const ALLOWED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Convert a verified GitHub delivery into a session-create intent without doing I/O.
 * Routing owns signature validation, persistence, and assignment; this layer intentionally
 * trusts neither repository names nor arbitrary payload fields for target selection.
 */
export function parseGitHubWebhookIngress(input: {
  event: string;
  payload: unknown;
  repositories: readonly GitHubWebhookRepositoryBinding[];
}): GitHubWebhookIngressResult {
  if (!isSupportedEvent(input.event)) return ignored("unsupported_event");
  const payload = record(input.payload);
  if (!payload) return ignored("invalid_payload");
  if (payload.action !== "created") return ignored("unsupported_action");

  const githubRepositoryId = positiveInteger(record(payload.repository)?.id);
  if (githubRepositoryId === undefined) return ignored("invalid_payload");
  const bindings = input.repositories.filter(
    (candidate) => candidate.githubRepositoryId === githubRepositoryId,
  );
  if (bindings.length === 0) return ignored("unconfigured_repository");
  if (bindings.length !== 1) return ignored("invalid_payload");
  const binding = bindings[0]!;
  if (
    !nonEmptyString(binding.repositoryId) ||
    !isTarget(binding.target) ||
    !validFallbacks(binding.fallbacks) ||
    !nonEmptyString(binding.defaultRef) ||
    !validAllowedLogins(binding.allowedLogins)
  ) {
    return ignored("invalid_payload");
  }

  const comment = record(payload.comment);
  const githubCommentId = positiveInteger(comment?.id);
  const authorAssociation = comment?.author_association;
  const githubAuthorLogin = record(comment?.user)?.login;
  const body = comment?.body;
  if (
    githubCommentId === undefined ||
    !nonEmptyString(authorAssociation) ||
    !nonEmptyString(githubAuthorLogin) ||
    !nonEmptyString(body)
  ) {
    return ignored("invalid_payload");
  }
  if (!isAuthorized(authorAssociation, githubAuthorLogin, binding.allowedLogins)) {
    return ignored("unauthorized_author");
  }
  const prompt = promptAfterMention(body);
  if (prompt === undefined) return ignored("missing_mention");

  const thread = threadFor(input.event, payload, binding.defaultRef);
  if (!thread) return ignored("invalid_payload");

  return {
    kind: "accepted",
    session: {
      repositoryId: binding.repositoryId,
      target: copyTarget(binding.target),
      prompt,
      ref: thread.ref,
      concurrencyId: `github-comment:${input.event}:${String(githubRepositoryId)}:${String(githubCommentId)}`,
      source: "webhook",
      metadata: {
        githubEvent: input.event,
        githubRepositoryId,
        githubCommentId,
        githubIssueNumber: thread.issueNumber,
        githubPullRequestNumber: thread.pullRequestNumber,
        githubAuthorLogin,
      },
      ...(binding.fallbacks ? { fallbacks: binding.fallbacks.map(copyTarget) } : {}),
    },
  };
}

function ignored(reason: Extract<GitHubWebhookIngressResult, { kind: "ignored" }>["reason"]) {
  return { kind: "ignored", reason } as const;
}

function isSupportedEvent(value: string): value is SupportedEvent {
  return value === "issue_comment" || value === "pull_request_review_comment";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTarget(value: unknown): value is TargetRef {
  const target = record(value);
  if (!target) return false;
  const hasProvider = target.providerId !== undefined;
  const hasCommand = target.commandId !== undefined;
  if (hasProvider === hasCommand) return false;
  return hasProvider ? nonEmptyString(target.providerId) : nonEmptyString(target.commandId);
}

function validFallbacks(
  value: readonly TargetRef[] | undefined,
): value is readonly TargetRef[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every(isTarget));
}

function validAllowedLogins(
  value: readonly string[] | undefined,
): value is readonly string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((login) => typeof login === "string"))
  );
}

function copyTarget(target: TargetRef): TargetRef {
  return "providerId" in target
    ? { providerId: target.providerId }
    : { commandId: target.commandId };
}

function isAuthorized(
  association: string,
  login: string,
  allowedLogins: readonly string[] | undefined,
): boolean {
  if (ALLOWED_ASSOCIATIONS.has(association)) return true;
  const normalizedLogin = login.toLowerCase();
  return (
    allowedLogins?.some(
      (candidate) => typeof candidate === "string" && candidate.toLowerCase() === normalizedLogin,
    ) ?? false
  );
}

/** A whitespace delimiter makes the mention a first token; the complete suffix is the prompt. */
function promptAfterMention(body: string): string | undefined {
  if (body.slice(0, MENTION.length).toLowerCase() !== MENTION) return undefined;
  const remainder = body.slice(MENTION.length);
  if (remainder.length === 0 || !/^\s/u.test(remainder)) return undefined;
  return /\S/u.test(remainder) ? remainder : undefined;
}

function threadFor(
  event: SupportedEvent,
  payload: Record<string, unknown>,
  defaultRef: string,
): { issueNumber: number; pullRequestNumber: number | null; ref: string } | undefined {
  if (event === "pull_request_review_comment") {
    const pullRequestNumber = positiveInteger(record(payload.pull_request)?.number);
    return pullRequestNumber === undefined
      ? undefined
      : {
          issueNumber: pullRequestNumber,
          pullRequestNumber,
          ref: `refs/pull/${String(pullRequestNumber)}/head`,
        };
  }

  const issue = record(payload.issue);
  const issueNumber = positiveInteger(issue?.number);
  if (issueNumber === undefined) return undefined;
  const isPullRequest = record(issue?.pull_request) !== undefined;
  return {
    issueNumber,
    pullRequestNumber: isPullRequest ? issueNumber : null,
    ref: isPullRequest ? `refs/pull/${String(issueNumber)}/head` : defaultRef,
  };
}
