/* eslint-disable max-lines -- parser edge cases share fixtures. */
import { describe, expect, it } from "vitest";

import { MAX_FALLBACKS, MAX_PROMPT_BYTES } from "@auto-harness/shared";

import {
  parseGitHubWebhookIngress,
  type GitHubWebhookRepositoryBinding,
} from "./github-webhook-ingress.ts";

const binding: GitHubWebhookRepositoryBinding = {
  githubRepositoryId: 42,
  repositoryId: "auto-harness",
  target: { commandId: "codex" },
  defaultRef: "refs/heads/main",
  timeout: 3600,
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
  repositoryId?: string,
) {
  expect(ingress(event, payload, repositories)).toEqual({
    kind: "ignored",
    reason,
    ...(repositoryId ? { repositoryId } : {}),
  });
}

describe("parseGitHubWebhookIngress", () => {
  it("turns an authorized issue comment into a bounded webhook session intent", () => {
    expect(ingress("issue_comment", issueComment())).toEqual({
      kind: "accepted",
      session: {
        repositoryId: "auto-harness",
        target: { commandId: "codex" },
        timeout: 3600,
        prompt: " fix it",
        ref: "refs/heads/main",
        concurrencyId: "github-comment:issue_comment:42:99",
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
        concurrencyId: "github-comment:issue_comment:42:100",
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
        concurrencyId: "github-comment:pull_request_review_comment:42:101",
        metadata: {
          githubEvent: "pull_request_review_comment",
          githubIssueNumber: 19,
          githubPullRequestNumber: 19,
          githubAuthorLogin: "Trusted-Contributor",
        },
      },
    });
  });

  it("rejects prompts over the shared UTF-8 byte limit", () => {
    const asciiPrompt = `${"x".repeat(MAX_PROMPT_BYTES)} `;
    expectIgnored(
      "issue_comment",
      issueComment({
        comment: { ...issueComment().comment, body: `@auto-harness ${asciiPrompt}` },
      }),
      "invalid_payload",
      undefined,
      "auto-harness",
    );

    const unicodePrompt = "é".repeat(Math.floor(MAX_PROMPT_BYTES / 2));
    expectIgnored(
      "issue_comment",
      issueComment({
        comment: { ...issueComment().comment, body: `@auto-harness ${unicodePrompt}` },
      }),
      "invalid_payload",
      undefined,
      "auto-harness",
    );
  });

  it("rejects bindings whose fallback routing cannot be used to create a session", () => {
    const tooManyFallbacks = Array.from({ length: MAX_FALLBACKS + 1 }, (_, index) => ({
      commandId: `fallback-${index}`,
    }));
    for (const candidate of [
      { ...binding, fallbacks: [{ commandId: "codex" }] },
      { ...binding, fallbacks: [{ commandId: "same" }, { commandId: "same" }] },
      { ...binding, fallbacks: tooManyFallbacks },
    ]) {
      expectIgnored(
        "issue_comment",
        issueComment(),
        "invalid_payload",
        [candidate],
        "auto-harness",
      );
    }
  });

  it("rejects invalid default refs and session timeouts in bindings", () => {
    for (const candidate of [
      { ...binding, defaultRef: "-main" },
      { ...binding, defaultRef: "refs/heads/main\nattacker" },
      { ...binding, timeout: 0 },
      { ...binding, timeout: Number.POSITIVE_INFINITY },
    ]) {
      expectIgnored(
        "issue_comment",
        issueComment(),
        "invalid_payload",
        [candidate],
        "auto-harness",
      );
    }
  });

  it("keeps issue and review comment concurrency namespaces distinct", () => {
    const issue = ingress(
      "issue_comment",
      issueComment({ comment: { ...issueComment().comment } }),
    );
    const review = ingress("pull_request_review_comment", {
      action: "created",
      repository: { id: 42 },
      pull_request: { number: 17 },
      comment: { ...issueComment().comment },
    });
    expect(issue).toMatchObject({
      kind: "accepted",
      session: { concurrencyId: "github-comment:issue_comment:42:99" },
    });
    expect(review).toMatchObject({
      kind: "accepted",
      session: { concurrencyId: "github-comment:pull_request_review_comment:42:99" },
    });
  });

  it("fails closed for unsupported, unconfigured, unauthorized, and malformed deliveries", () => {
    for (const [event, payload, reason, repositoryId] of [
      ["issues", issueComment(), "unsupported_event", undefined],
      ["issue_comment", issueComment({ action: "edited" }), "unsupported_action", undefined],
      [
        "issue_comment",
        issueComment({ repository: { id: 43 } }),
        "unconfigured_repository",
        undefined,
      ],
      ["issue_comment", issueComment({ comment: { id: "99" } }), "invalid_payload", "auto-harness"],
    ] as const) {
      expectIgnored(event, payload, reason, undefined, repositoryId);
    }
  });

  it("retains the resolved repository scope for denied configured comments", () => {
    expect(
      ingress(
        "issue_comment",
        issueComment({
          comment: {
            id: 99,
            body: "@auto-harness denied",
            author_association: "NONE",
            user: { login: "stranger" },
          },
        }),
      ),
    ).toEqual({ kind: "ignored", reason: "unauthorized_author", repositoryId: "auto-harness" });
    expect(
      ingress(
        "issue_comment",
        issueComment({ comment: { ...issueComment().comment, body: "please help" } }),
      ),
    ).toEqual({ kind: "ignored", reason: "missing_mention", repositoryId: "auto-harness" });
  });
});
