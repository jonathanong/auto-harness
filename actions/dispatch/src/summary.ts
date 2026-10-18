import { appendFileSync } from "node:fs";

import { escapeWorkflowCommand } from "./io.ts";

type SummarySession = {
  id: string;
  url: string;
  created: boolean;
  target?: unknown;
  concurrencyId?: unknown;
};

// Renders an untrusted value as one inline-code span: backticks and newlines cannot break out.
function code(value: string): string {
  return `\`${value.replaceAll("`", "'").replaceAll(/[\r\n]+/g, " ")}\``;
}

/** Writes a step summary and a notice annotation for a dispatched or resumed session. */
export function writeSessionSummary(verb: "Dispatched" | "Resumed", session: SummarySession): void {
  process.stdout.write(
    `::notice title=Auto Harness::${escapeWorkflowCommand(`${verb} session ${session.id}: ${session.url}`)}\n`,
  );
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const lines = [
    `### ${verb} Auto Harness session`,
    "",
    `- Session: [${code(session.id)}](${encodeURI(session.url).replaceAll("(", "%28").replaceAll(")", "%29")})`,
    `- Created: ${session.created ? "yes" : "no (existing session)"}`,
  ];
  if (session.target && typeof session.target === "object") {
    lines.push(`- Provider route: ${code(JSON.stringify(session.target))}`);
  }
  if (typeof session.concurrencyId === "string" && session.concurrencyId) {
    lines.push(`- Concurrency ID: ${code(session.concurrencyId)}`);
  }
  try {
    appendFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
  } catch (error) {
    // The session is already accepted; a summary failure must not fail the step and invite a rerun.
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `::warning::${escapeWorkflowCommand(`Could not write the step summary: ${message}`)}\n`,
    );
  }
}
