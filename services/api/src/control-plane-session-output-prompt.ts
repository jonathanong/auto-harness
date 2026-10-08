import { materializeResumeArgv, type SessionResumeSpec } from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

const POINTER =
  "If relevant, you may write the final JSON value to $HARNESS_OUTPUT_FILE and place files to keep in $HARNESS_ARTIFACTS_DIR.";

export function appendSessionOutputPointer(prompt: string): string {
  return prompt.endsWith(`\n\n${POINTER}`) ? prompt : `${prompt}\n\n${POINTER}`;
}

/** The pointer belongs to the final CLI prompt, after routing and native-resume expansion. */
export function assignmentOutputArgv(
  state: ControlPlaneState,
  session: SessionRecord,
  commandId: string,
  argv: readonly string[],
  supported: boolean,
  routeSpec?: SessionResumeSpec,
): string[] {
  if (!supported || !session.prompt) return [...argv];
  const pointed = appendSessionOutputPointer(session.prompt);
  if (session.cliResumeRef && !session.resumeFallback && routeSpec?.resumeArgvTemplate) {
    return materializeResumeArgv(
      routeSpec.resumeArgvTemplate,
      session.cliResumeRef,
      pointed,
      routeSpec.appendPromptSeparator,
    );
  }
  const command = state.commands.get(commandId);
  if (!command?.appendPrompt || argv.at(-1) !== session.prompt) return [...argv];
  return [...argv.slice(0, -1), pointed];
}
