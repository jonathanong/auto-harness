export function filamentsCreateSessionBody(input: {
  commandId: string;
  concurrencyId: string;
  prompt: string;
  repositoryId: string;
}) {
  return {
    repositoryId: input.repositoryId,
    prompt: input.prompt,
    target: { commandId: input.commandId },
    ref: "refs/heads/main",
    timeout: 6300,
    priority: 20,
    requiredLabels: ["filaments"],
    concurrencyId: input.concurrencyId,
    metadata: { issueNumber: 9366, repository: "jonathanong/filaments" },
    source: "webhook",
  } as const;
}

export function filamentsResumeSessionBody(prompt: string, concurrencyId: string) {
  return { prompt, concurrencyId, timeout: 6300, priority: 21 } as const;
}
