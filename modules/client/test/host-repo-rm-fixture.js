/** Shared fixture for the `host repo rm` test files. Deliberately not named `*.test.js` — the
 * test script globs `test/*.test.js`, and a helper matching that pattern would both run as its
 * own (empty) test file and, worse, re-run any tests defined in whichever file imports it. */
export function makeRecord() {
  return {
    hostId: "host-1",
    version: 29,
    repositories: [
      {
        id: "repo-a",
        path: "/repos/a",
        defaultBranch: "main",
        worktrees: [{ id: "wt-1" }, { id: "wt-2" }],
      },
      { id: "repo-b", path: "/repos/b", defaultBranch: "main", worktrees: [] },
    ],
    providerAccounts: [{ providerAccountId: "acct-1", provider: "github" }],
    capabilities: { docker: true },
    runtime: { nodeVersion: "24.0.0" },
  };
}
