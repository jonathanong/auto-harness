import { basename } from "node:path";

export function sessionFeedbackInstructions(path: string): string {
  return `\n\nHarness reporting requirement: before returning, write UTF-8 JSON to ${JSON.stringify(path)}. The trusted Harness controller delivers it. Assess architecture, sandbox/approval/guards, and tool/workflow/validation use. Record none-observed only after assessing that area and state the inspected scope; record bounded reasons for not-assessed/unavailable; list each applicable workflow tool as used, skipped, or unavailable with its reason; use not-assessed or unavailable honestly. Keep the report under 8192 bytes, at most 20 findings, each summary/source under 256 UTF-8 bytes. Include no logs, commands, prompts, credentials, absolute paths, or arbitrary fields. Reporting is required even for no change, refusal, or abort when you can report. A missing/invalid report leaves successful work visibly incomplete.\nSchema example (replace assessment/coverage/outcome with evidence): {"schemaVersion":1,"completionKind":"no-change","feedbackCoverage":"partial","assessments":{"architecture":"not-assessed","sandbox":"not-assessed","tools":"not-assessed"},"assessmentEvidence":{"architecture":"Repository architecture was not inspected in this attempt.","sandbox":"Execution restrictions were not assessed in this attempt.","tools":"Applicable workflow tools were not assessed in this attempt."},"toolAssessments":[],"findings":[],"droppedCount":0}.\ncompletionKind: changed|no-change|policy-refusal|shepherd-terminal|aborted; feedbackCoverage: complete|partial|unavailable; assessments: finding|none-observed|not-assessed|unavailable. Each finding: {"category":"architecture|sandbox|approval|guard|workflow|validation|tool","recurrence":"recurring|one-off","summary":"bounded sanitized observation","source":"optional repository-relative file"}. assessmentEvidence requires architecture/sandbox/tools scope or reason, each under 256 UTF-8 bytes. toolAssessments has at most 10 {name,status:used|skipped|unavailable,reason} records, with name under64 and reason under256 UTF-8 bytes; empty means no applicable tools, justified in tools evidence. droppedCount is a cumulative lower bound for lost observations when replacing the file. Complete requires all areas assessed and droppedCount 0. shepherd-terminal additionally requires shepherdAction merged|closed|ready|blocked|cancelled from an observed terminal action.\n`;
}

/** Only known provider prompt modes are changed; custom commands receive the explicit hook/env contract. */
export function feedbackCommandArgv(
  argv: readonly string[],
  path: string,
  bindings: readonly { index: number; start: number; end: number }[] = [],
): string[] {
  const executable = basename(argv[0] ?? "");
  if (!["codex", "claude", "opencode", "agent", "cursor-agent", "grok"].includes(executable))
    return [...argv];
  const result = [...argv];
  if (
    bindings.length > 16 ||
    bindings.some(
      ({ index, start, end }) =>
        !Number.isSafeInteger(index) ||
        index < 1 ||
        index >= argv.length ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end > argv[index]!.length,
    )
  )
    return result;
  for (const { index, end } of [...bindings].toSorted(
    (a, b) => b.index - a.index || b.end - a.end,
  )) {
    result[index] =
      result[index]!.slice(0, end) + sessionFeedbackInstructions(path) + result[index]!.slice(end);
  }
  return result;
}
