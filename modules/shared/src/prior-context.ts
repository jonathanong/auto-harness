import { MAX_PROMPT_BYTES } from "./validation.ts";

/** Reserved worktree directory the host daemon writes the prior-session transcript into. */
export const PRIOR_CONTEXT_DIR = ".auto-harness";

export const PRIOR_CONTEXT_FILENAME = "prior-session.md";

/** Path relative to the worktree root, shared by the control plane (in the prompt pointer)
 * and the host daemon (which resolves and writes it) — never sent as a path over the wire. */
export const PRIOR_CONTEXT_RELATIVE_PATH = `${PRIOR_CONTEXT_DIR}/${PRIOR_CONTEXT_FILENAME}`;

/** Hard cap on the rendered transcript. Generous — this is a file the agent greps, not a
 * prompt fragment — but bounded so a runaway session cannot fill a worktree. */
export const MAX_PRIOR_CONTEXT_BYTES = 2 * 1024 * 1024;

/**
 * Fixed literal pointer appended to a resume prompt when the run falls back to a fresh
 * route (native CLI resume was unavailable, or the target was rebound). Never interpolated
 * and never derived from a wire value — it is one static sentence riding inside the single
 * prompt argv element a Command appends, so it carries no shell-interpolation risk. Hedged
 * ("may be available") because the source transcript can be gone (7-day log retention) or
 * the fetch can fail, and the file must never be promised unconditionally.
 */
const PRIOR_CONTEXT_PROMPT_POINTER = `\n\nA transcript of the previous session may be available at \`${PRIOR_CONTEXT_RELATIVE_PATH}\` in the working directory. Read or search that file if you need context from the previous run. It is not part of the repository and must not be committed.`;

/**
 * Append the prior-context pointer to a resume prompt, once. Idempotent because
 * `resumeFallback` can be set more than once for the same session (pin expiry can be
 * re-evaluated across placement passes) — a second append would otherwise duplicate the
 * sentence. Capped because the result is not re-validated against `MAX_PROMPT_BYTES`
 * downstream; when appending would exceed the cap the prompt is returned unchanged rather
 * than silently truncating mid-sentence.
 */
export function appendPriorContextPointer(prompt: string): string {
  if (hasPriorContextPointer(prompt)) return prompt;
  const next = prompt + PRIOR_CONTEXT_PROMPT_POINTER;
  return new TextEncoder().encode(next).length > MAX_PROMPT_BYTES ? prompt : next;
}

export function hasPriorContextPointer(prompt: string): boolean {
  return prompt.includes(PRIOR_CONTEXT_RELATIVE_PATH);
}
