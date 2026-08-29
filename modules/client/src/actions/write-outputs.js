import { appendFileSync } from "node:fs";

function formatTargetRef(ref) {
  if ("providerId" in ref) return `\`${ref.providerId}\``;
  if ("providerName" in ref) return `\`${ref.providerName}\``;
  if ("commandId" in ref) return `\`${ref.commandId}\``;
  return `\`${ref.commandName}\``;
}

export function writeOutputs(environment, result, route) {
  if (environment.GITHUB_OUTPUT) {
    appendFileSync(
      environment.GITHUB_OUTPUT,
      `session-id=${result.id}\nsession-url=${result.url}\ncreated=${result.created}\n`,
      "utf8",
    );
  }
  if (environment.GITHUB_STEP_SUMMARY) {
    const routeText = route
      ? route.map(formatTargetRef).join(" → ")
      : "retained from the existing session";
    const concurrencyId = environment.HARNESS_CONCURRENCY_ID?.trim();
    appendFileSync(
      environment.GITHUB_STEP_SUMMARY,
      [
        "## Auto Harness dispatch",
        "",
        `- Session: [${result.id}](${result.url})`,
        `- Created: ${result.created ? "yes" : "no"}`,
        ...(concurrencyId ? [`- Concurrency: \`${concurrencyId}\``] : []),
        `- Provider route: ${routeText}`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
  if (environment.GITHUB_ACTIONS === "true") {
    process.stdout.write(
      `::notice title=Auto Harness session::${result.id} ${result.created ? "created" : "reused"} ${result.url}\n`,
    );
  }
}
