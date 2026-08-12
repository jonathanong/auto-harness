import type { ResumeRefCapture } from "@auto-harness/shared";

export function commandPatchFromBody(body: Record<string, unknown>): {
  name?: string;
  argv?: string[];
  appendPrompt?: boolean;
  providerId?: string | null;
  resumeArgvTemplate?: string[] | null;
  resumeRefCapture?: ResumeRefCapture | null;
} {
  return {
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(Array.isArray(body.argv) ? { argv: body.argv as string[] } : {}),
    ...(typeof body.appendPrompt === "boolean" ? { appendPrompt: body.appendPrompt } : {}),
    ...(typeof body.providerId === "string" || body.providerId === null
      ? { providerId: body.providerId }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(body, "resumeArgvTemplate")
      ? { resumeArgvTemplate: body.resumeArgvTemplate as string[] | null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(body, "resumeRefCapture")
      ? { resumeRefCapture: body.resumeRefCapture as ResumeRefCapture | null }
      : {}),
  };
}
