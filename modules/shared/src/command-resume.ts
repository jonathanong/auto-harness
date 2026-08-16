import type { Command, ResumeRefCapture } from "./providers.ts";

export const MAX_COMMAND_ARGV_ITEMS = 64;
export const MAX_COMMAND_ARG_LENGTH = 4096;
export const MAX_RESUME_REF_CAPTURE_LENGTH = 128;
const MAX_CLI_RESUME_REF_BYTES = 512;

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
const ALLOWED_PLACEHOLDERS = new Set(["prompt", "cliResumeRef"]);

export type CommandResumeSpec = Pick<Command, "resumeArgvTemplate" | "resumeRefCapture">;

function safeArg(value: unknown, label: string): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return `${label} must contain non-empty strings`;
  }
  if (value.length > MAX_COMMAND_ARG_LENGTH) {
    return `${label} entries must be at most ${MAX_COMMAND_ARG_LENGTH} characters`;
  }
  if (hasControlChars(value)) {
    return `${label} entries must not contain control characters`;
  }
  return null;
}

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function isValidCliResumeRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_CLI_RESUME_REF_BYTES &&
    !hasControlChars(value)
  );
}

export function validateCommandArgv(
  argv: unknown,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_COMMAND_ARGV_ITEMS) {
    return { ok: false, error: `argv must contain 1-${MAX_COMMAND_ARGV_ITEMS} entries` };
  }
  for (const arg of argv) {
    const error = safeArg(arg, "argv");
    if (error) return { ok: false, error };
  }
  return { ok: true, value: [...(argv as string[])] };
}

/** Validate and normalize the optional native resume fields on a Command. */
export function validateCommandResumeSpec(input: {
  resumeArgvTemplate?: unknown;
  resumeRefCapture?: unknown;
}): { ok: true; value: CommandResumeSpec } | { ok: false; error: string } {
  let resumeArgvTemplate: string[] | undefined;
  if (input.resumeArgvTemplate !== undefined && input.resumeArgvTemplate !== null) {
    if (
      !Array.isArray(input.resumeArgvTemplate) ||
      input.resumeArgvTemplate.length === 0 ||
      input.resumeArgvTemplate.length > MAX_COMMAND_ARGV_ITEMS
    ) {
      return {
        ok: false,
        error: `resumeArgvTemplate must contain 1-${MAX_COMMAND_ARGV_ITEMS} argv entries`,
      };
    }
    for (const arg of input.resumeArgvTemplate) {
      const error = safeArg(arg, "resumeArgvTemplate");
      if (error) return { ok: false, error };
      const text = arg as string;
      let match: RegExpExecArray | null;
      PLACEHOLDER.lastIndex = 0;
      while ((match = PLACEHOLDER.exec(text)) !== null) {
        if (!ALLOWED_PLACEHOLDERS.has(match[1]!)) {
          return { ok: false, error: `unsupported resume placeholder: ${match[1]}` };
        }
      }
      const withoutPlaceholders = text.replace(PLACEHOLDER, "");
      if (withoutPlaceholders.includes("{") || withoutPlaceholders.includes("}")) {
        return { ok: false, error: "resumeArgvTemplate contains malformed placeholders" };
      }
    }
    resumeArgvTemplate = [...(input.resumeArgvTemplate as string[])];
    const cliResumeRefCount = resumeArgvTemplate.reduce(
      (count, arg) => count + (arg.match(/\{cliResumeRef\}/g)?.length ?? 0),
      0,
    );
    if (cliResumeRefCount !== 1) {
      return {
        ok: false,
        error: "resumeArgvTemplate must contain exactly one {cliResumeRef} placeholder",
      };
    }
  }

  let resumeRefCapture: ResumeRefCapture | undefined;
  if (input.resumeRefCapture !== undefined && input.resumeRefCapture !== null) {
    if (
      typeof input.resumeRefCapture !== "object" ||
      Array.isArray(input.resumeRefCapture) ||
      input.resumeRefCapture === null
    ) {
      return { ok: false, error: "resumeRefCapture must be an object" };
    }
    const capture = input.resumeRefCapture as Record<string, unknown>;
    if (!["stdout", "stderr", "either"].includes(capture.stream as string)) {
      return { ok: false, error: "resumeRefCapture.stream must be stdout, stderr, or either" };
    }
    if (typeof capture.linePrefix !== "string" || capture.linePrefix.length === 0) {
      return { ok: false, error: "resumeRefCapture.linePrefix must be a non-empty string" };
    }
    if (capture.linePrefix.length > MAX_RESUME_REF_CAPTURE_LENGTH) {
      return {
        ok: false,
        error: `resumeRefCapture.linePrefix must be at most ${MAX_RESUME_REF_CAPTURE_LENGTH} characters`,
      };
    }
    if (hasControlChars(capture.linePrefix)) {
      return {
        ok: false,
        error: "resumeRefCapture.linePrefix must not contain control characters",
      };
    }
    resumeRefCapture = {
      stream: capture.stream as ResumeRefCapture["stream"],
      linePrefix: capture.linePrefix,
    };
  }

  return {
    ok: true,
    value: {
      ...(resumeArgvTemplate !== undefined ? { resumeArgvTemplate } : {}),
      ...(resumeRefCapture !== undefined ? { resumeRefCapture } : {}),
    },
  };
}

/** Expand a validated argv template without ever invoking a shell. */
export function materializeResumeArgv(
  template: readonly string[],
  resumeRef: string,
  prompt: string,
  appendPromptSeparator = false,
): string[] {
  const argv: string[] = [];
  for (const arg of template) {
    // Same opt-in `--` guard as buildArgv (control-plane-session-target.ts), for the same
    // reason: only safe when the whole element is the prompt placeholder, not embedded in a
    // larger operator-authored string.
    if (appendPromptSeparator && arg === "{prompt}") {
      argv.push("--", prompt);
      continue;
    }
    argv.push(
      arg.replace(/\{(cliResumeRef|prompt)\}/g, (_match, placeholder: string) =>
        placeholder === "cliResumeRef" ? resumeRef : prompt,
      ),
    );
  }
  return argv;
}
