export const valid = {
  agentId: "local-1",
  commandProfiles: {
    "echo-prompt": { argv: ["echo"], appendPrompt: true },
  },
  repositories: [
    {
      id: "repo-1",
      path: "/tmp/repo",
      defaultBranch: "main",
      setupScript: "true",
      terminalHookScript: "/tmp/hook.sh",
      worktrees: [
        {
          id: "wt-1",
          path: "/tmp/repo/wt-1",
          labels: ["codex"],
          setupScript: "true",
        },
      ],
    },
  ],
};
