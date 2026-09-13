import { describe, expect, it } from "vitest";

import { MAX_FALLBACKS } from "@auto-harness/shared";

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
};

function issueComment(overrides: Record<string, unknown> = {}) {
  return {
    action: "created",
    repository: { id: 42 },
    issue: { number: 17 },
    comment: {
      id: 99,
      body: "@auto-harness fix it",
      author_association: "OWNER",
      user: { login: "owner" },
    },
    ...overrides,
  };
}

function expectIgnored(
  event: string,
  payload: unknown,
  reason: string,
  repositories: readonly GitHubWebhookRepositoryBinding[] = [binding],
) {
  expect(parseGitHubWebhookIngress({ event, payload, repositories })).toEqual({
    kind: "ignored",
    reason,
  });
}

describe("parseGitHubWebhookIngress edge cases", () => {
  it("fails closed for malformed bindings and incomplete threads", () => {
    const malformedBindings = [
      { ...binding, target: null },
      { ...binding, target: { providerId: "codex-provider", commandId: "codex" } },
      { ...binding, target: { providerId: "", commandId: "codex" } },
      { ...binding, target: { providerId: 42, commandId: "codex" } },
      { ...binding, fallbacks: [{ providerId: "" }] },
      { ...binding, fallbacks: [{ commandId: "codex" }] },
      { ...binding, fallbacks: [{ commandId: "duplicate" }, { commandId: "duplicate" }] },
      {
        ...binding,
        fallbacks: Array.from({ length: MAX_FALLBACKS + 1 }, (_, index) => ({
          commandId: `fallback-${index}`,
        })),
      },
      { ...binding, defaultRef: "-main" },
      { ...binding, timeout: 0 },
      { ...binding, allowedLogins: "trusted-contributor" },
      { ...binding, allowedLogins: { login: "trusted-contributor" } },
      { ...binding, allowedLogins: ["trusted-contributor", 42] },
    ] as unknown as readonly GitHubWebhookRepositoryBinding[];
    const cases: ReadonlyArray<{
      event: string;
      payload: unknown;
      repositories?: readonly GitHubWebhookRepositoryBinding[];
    }> = [
      { event: "issue_comment", payload: null },
      { event: "issue_comment", payload: issueComment({ repository: { id: "42" } }) },
      { event: "issue_comment", payload: issueComment(), repositories: [binding, binding] },
      ...malformedBindings.map((repository) => ({
        event: "issue_comment",
        payload: issueComment(),
        repositories: [repository],
      })),
      {
        event: "pull_request_review_comment",
        payload: {
          action: "created",
          repository: { id: 42 },
          pull_request: { number: 0 },
          comment: {
            id: 99,
            body: "@auto-harness inspect",
            author_association: "OWNER",
            user: { login: "owner" },
          },
        },
      },
      { event: "issue_comment", payload: issueComment({ issue: { number: 0 } }) },
    ];
    for (const testCase of cases) {
      expectIgnored(testCase.event, testCase.payload, "invalid_payload", testCase.repositories);
    }
  });

  it("does not grant an unassociated author access without an allowlist", () => {
    expectIgnored(
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
    );
  });

  it("preserves provider targets and fallbacks from the immutable repository binding", () => {
    expect(
      parseGitHubWebhookIngress({
        event: "issue_comment",
        payload: issueComment(),
        repositories: [
          {
            ...binding,
            target: { providerId: "codex-provider" },
            fallbacks: [{ commandId: "claude" }],
          },
        ],
      }),
    ).toMatchObject({
      kind: "accepted",
      session: {
        target: { providerId: "codex-provider" },
        fallbacks: [{ commandId: "claude" }],
      },
    });
  });

  it("requires a standalone first-token mention with a non-empty remainder", () => {
    for (const body of [
      "prefix @auto-harness fix it",
      "@auto-harness: fix it",
      "@auto-harness",
      "@auto-harness ",
    ]) {
      expectIgnored(
        "issue_comment",
        issueComment({ comment: { ...issueComment().comment, body } }),
        "missing_mention",
      );
    }
  });
});
