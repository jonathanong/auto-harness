import { createHmac, timingSafeEqual } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, basename, join, relative, resolve } from "node:path";

export const dynamic = "force-dynamic";

const MAX_RESULTS = 20;
const browseRoot = resolve(process.env.HARNESS_HOST_PANE_BROWSE_ROOT ?? homedir());

function isWithinBrowseRoot(path: string): boolean {
  const rel = relative(browseRoot, resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.includes("../"));
}

/**
 * Directory-only autocomplete for path fields — this host's own filesystem,
 * never proxied to the control plane (which isn't running on this machine).
 * GET /api/browse?path=<partial absolute path> -> {items: string[]}
 */
export async function GET(request: Request): Promise<Response> {
  if (process.env.HARNESS_AUTH_MODE === "required" && !hasValidSession(request)) {
    return new Response("authentication required", { status: 401 });
  }
  const raw = new URL(request.url).searchParams.get("path")?.trim() ?? "";
  const input = raw || browseRoot;
  if (!isWithinBrowseRoot(input)) return Response.json({ items: [] });

  const searchDir = input.endsWith("/") ? input : dirname(input);
  if (!isWithinBrowseRoot(searchDir)) return Response.json({ items: [] });
  const prefix = input.endsWith("/") ? "" : basename(input).toLowerCase();

  let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    const [resolvedRoot, actualSearchDir] = await Promise.all([
      realpath(browseRoot),
      realpath(searchDir),
    ]);
    if (!isWithin(resolvedRoot, actualSearchDir)) return Response.json({ items: [] });
    entries = await readdir(actualSearchDir, { withFileTypes: true });
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

function hasValidSession(request: Request): boolean {
  const secret = process.env.HARNESS_SESSION_SECRET;
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("auto_harness_session="))
    ?.slice("auto_harness_session=".length);
  if (!secret || !token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts as [string, string, string];
  if (!header || !payload || !signature) return false;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  if (signature.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try {
    const protectedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as {
      alg?: unknown;
      typ?: unknown;
    };
    if (protectedHeader.alg !== "HS256" || protectedHeader.typ !== "JWT") return false;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof parsed.exp === "number" && parsed.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.includes("../"));
}
