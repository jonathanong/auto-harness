import { describe, expect, it } from "vitest";

import {
  parseGitHubWebhookIngress,
  type GitHubWebhookRepositoryBinding,
} from "./github-webhook-ingress.ts";

const binding: GitHubWebhookRepositoryBinding = {
  githubRepositoryId: 42,
  repositoryId: "auto-harness",
  target: { commandId: "codex" },
  defaultRef: "refs/heads/main",
  allowedLogins: ["trusted-contributor"],
};

function issueComment(overrides: Record<string, unknown> = {}) {
  return {
    action: "created",
    repository: { id: 42 },
    issue: { number: 17 },
    comment: {
      id: 99,
      body: "@auto-harness fix it",
      author_association: "MEMBER",
      user: { login: "maintainer" },
    },
    ...overrides,
  };
}

function ingress(
  event: string,
  payload: unknown,
  repositories: readonly GitHubWebhookRepositoryBinding[] = [binding],
) {
  return parseGitHubWebhookIngress({ event, payload, repositories });
}

function expectIgnored(
  event: string,
  payload: unknown,
  reason: string,
  repositories?: readonly GitHubWebhookRepositoryBinding[],
) {
  expect(ingress(event, payload, repositories)).toEqual({ kind: "ignored", reason });
}

describe("parseGitHubWebhookIngress", () => {
  it("turns an authorized issue comment into a bounded webhook session intent", () => {
    expect(ingress("issue_comment", issueComment())).toEqual({
      kind: "accepted",
      session: {
        repositoryId: "auto-harness",
        target: { commandId: "codex" },
        prompt: " fix it",
        ref: "refs/heads/main",
        concurrencyId: "github-comment:42:99",
        source: "webhook",
        metadata: {
          githubEvent: "issue_comment",
          githubRepositoryId: 42,
          githubCommentId: 99,
          githubIssueNumber: 17,
          githubPullRequestNumber: null,
          githubAuthorLogin: "maintainer",
        },
      },
    });
  });

  it("uses a pull ref for issue comments on pull requests and preserves the prompt remainder", () => {
    expect(
      ingress(
        "issue_comment",
        issueComment({
          issue: { number: 18, pull_request: {} },
          comment: {
            id: 100,
            body: "@auto-harness  preserve this leading space",
            author_association: "COLLABORATOR",
            user: { login: "collaborator" },
          },
        }),
      ),
    ).toMatchObject({
      kind: "accepted",
      session: {
        prompt: "  preserve this leading space",
        ref: "refs/pull/18/head",
        concurrencyId: "github-comment:42:100",
        metadata: { githubIssueNumber: 18, githubPullRequestNumber: 18 },
      },
    });
  });

  it("accepts case-insensitive mentions and allowed logins for review comments", () => {
    expect(
      ingress("pull_request_review_comment", {
        action: "created",
        repository: { id: 42 },
        pull_request: { number: 19 },
        comment: {
          id: 101,
          body: "@Auto-Harness inspect this line",
          author_association: "CONTRIBUTOR",
          user: { login: "Trusted-Contributor" },
        },
      }),
    ).toMatchObject({
      kind: "accepted",
      session: {
        ref: "refs/pull/19/head",
        metadata: {
          githubEvent: "pull_request_review_comment",
          githubIssueNumber: 19,
          githubPullRequestNumber: 19,
          githubAuthorLogin: "Trusted-Contributor",
        },
      },
    });
  });

  it("fails closed for unsupported, unconfigured, unauthorized, and malformed deliveries", () => {
    for (const [event, payload, reason] of [
      ["issues", issueComment(), "unsupported_event"],
      ["issue_comment", issueComment({ action: "edited" }), "unsupported_action"],
      ["issue_comment", issueComment({ repository: { id: 43 } }), "unconfigured_repository"],
      [
        "issue_comment",
        issueComment({
          comment: {
            id: 99,
            body: "@auto-harness denied",
            author_association: "NONE",
            user: { login: "stranger" },
          },
        }),
        "unauthorized_author",
      ],
      ["issue_comment", issueComment({ comment: { id: "99" } }), "invalid_payload"],
    ]) {
      expectIgnored(event, payload, reason);
    }
  });
});
