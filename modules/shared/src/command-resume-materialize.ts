/** Expand a validated argv template without ever invoking a shell. */
export function materializeResumeArgv(
  template: readonly string[],
  resumeRef: string,
  prompt: string,
  appendPromptSeparator = false,
): string[] {
  return materializeResumeArgvWithPromptBindings(template, resumeRef, prompt, appendPromptSeparator)
    .argv;
}

/** Bound prompt spans are computed from trusted templates, never inferred from arbitrary argv values. */
export function materializeResumeArgvWithPromptBindings(
  template: readonly string[],
  resumeRef: string,
  prompt: string,
  appendPromptSeparator = false,
): {
  argv: string[];
  promptBindings: Array<{ index: number; start: number; end: number }>;
} {
  const argv: string[] = [];
  const promptBindings: Array<{ index: number; start: number; end: number }> = [];
  for (const arg of template) {
    if (appendPromptSeparator && arg === "{prompt}") argv.push("--");
    let output = "";
    let cursor = 0;
    for (const match of arg.matchAll(/\{(cliResumeRef|prompt)\}/g)) {
      output += arg.slice(cursor, match.index);
      if (match[1] === "prompt") {
        promptBindings.push({
          index: argv.length,
          start: output.length,
          end: output.length + prompt.length,
        });
        output += prompt;
      } else output += resumeRef;
      cursor = match.index + match[0].length;
    }
    argv.push(output + arg.slice(cursor));
  }
  return { argv, promptBindings };
}
