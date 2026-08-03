export function baseSessionBody(over: Record<string, unknown> = {}) {
  return {
    repositoryId: "repo-1",
    prompt: "do work",
    commandProfile: "echo-prompt",
    timeout: 30,
    ...over,
  };
}
