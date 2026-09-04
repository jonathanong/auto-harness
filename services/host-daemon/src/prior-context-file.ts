import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  MAX_PRIOR_CONTEXT_BYTES,
  PRIOR_CONTEXT_DIR,
  PRIOR_CONTEXT_FILENAME,
} from "@auto-harness/shared";

import { assertPathWithinAllowedRoots } from "./allowed-roots.ts";
import { httpBaseFromApiUrl } from "./bootstrap.ts";

const FETCH_TIMEOUT_MS = 30_000;
/** A generous multiple of the server's own render cap, absorbing JSON escaping
 * overhead without trusting an unbounded declared or actual response size. */
const MAX_RESPONSE_BYTES = MAX_PRIOR_CONTEXT_BYTES * 2;
const GITIGNORE_CONTENTS = "*\n";

export type PriorContextIdentity = { apiUrl: string; apiKey?: string };

type FetchFn = typeof fetch;

/**
 * Fetch the running session's prior-context transcript from the control
 * plane and write it into the worktree at the fixed, shared path, alongside
 * a directory-local `.gitignore` so the agent cannot commit it. Every
 * failure — network, non-2xx, malformed body, or a containment violation —
 * is swallowed and returns `null`: writing prior context must never fail
 * the session it accompanies.
 */
export async function writePriorContextFile(input: {
  cwd: string;
  sessionId: string;
  identity: PriorContextIdentity;
  allowedRoots?: readonly string[];
  fetchFn?: FetchFn;
  onLog?: (message: string) => void;
}): Promise<string | null> {
  try {
    const content = await fetchPriorContext(input);
    if (content === null) return null;
    const roots = input.allowedRoots ?? [];
    const dir = join(input.cwd, PRIOR_CONTEXT_DIR);
    const file = await assertPathWithinAllowedRoots(join(dir, PRIOR_CONTEXT_FILENAME), roots);
    const gitignore = await assertPathWithinAllowedRoots(join(dir, ".gitignore"), roots);
    await mkdir(dir, { recursive: true });
    await writeFile(gitignore, GITIGNORE_CONTENTS, "utf8");
    await writeFile(file, content, "utf8");
    return file;
  } catch (error) {
    input.onLog?.(
      `prior-session context unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** Best-effort cleanup after the run finishes; never throws. */
export async function removePriorContextFile(path: string | null): Promise<void> {
  if (!path) return;
  await rm(path, { force: true }).catch(() => undefined);
}

async function fetchPriorContext(input: {
  sessionId: string;
  identity: PriorContextIdentity;
  fetchFn?: FetchFn;
}): Promise<string | null> {
  const fetchFn = input.fetchFn ?? fetch;
  const base = httpBaseFromApiUrl(input.identity.apiUrl);
  const url = `${base}/api/v1/sessions/${encodeURIComponent(input.sessionId)}/prior-context`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.identity.apiKey) headers.authorization = `Bearer ${input.identity.apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, { headers, signal: controller.signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`prior-context fetch failed: ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new Error(`prior-context response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    const body = (await response.json()) as { content?: unknown };
    if (typeof body.content !== "string") {
      throw new Error("prior-context response missing content");
    }
    return body.content.length > MAX_RESPONSE_BYTES
      ? body.content.slice(0, MAX_RESPONSE_BYTES)
      : body.content;
  } finally {
    clearTimeout(timer);
  }
}
