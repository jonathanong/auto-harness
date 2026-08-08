import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, basename, join } from "node:path";

export const dynamic = "force-dynamic";

const MAX_RESULTS = 20;

/**
 * Directory-only autocomplete for path fields — this host's own filesystem,
 * never proxied to the control plane (which isn't running on this machine).
 * GET /api/browse?path=<partial absolute path> -> {items: string[]}
 */
export async function GET(request: Request): Promise<Response> {
  const raw = new URL(request.url).searchParams.get("path")?.trim() ?? "";
  const input = raw || homedir();

  const searchDir = input.endsWith("/") ? input : dirname(input);
  const prefix = input.endsWith("/") ? "" : basename(input).toLowerCase();

  let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    entries = await readdir(searchDir, { withFileTypes: true });
  } catch {
    return Response.json({ items: [] });
  }

  const items = entries
    .filter((e) => e.isDirectory())
    .filter((e) => e.name.toLowerCase().startsWith(prefix))
    .filter((e) => prefix.startsWith(".") || !e.name.startsWith("."))
    .map((e) => e.name)
    .toSorted((a, b) => a.localeCompare(b))
    .slice(0, MAX_RESULTS)
    .map((name) => join(searchDir, name));

  return Response.json({ items });
}
