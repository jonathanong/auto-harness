/**
 * Purpose-built scanner for docs/openapi.yaml's `paths:` block, plus small text-extraction
 * helpers over services/api/src/auth-policy.ts. Not a general YAML parser: the spec's
 * path/method/security shape is regular enough (fixed 2-/4-space indentation) that a line
 * scan is simpler and dependency-free. See scripts/openapi-auth-policy.test.ts for how this
 * is used to cross-check the spec against the route policy.
 */
const METHOD_NAMES = ["get", "post", "put", "patch", "delete", "options", "head", "trace"];
const METHOD_RE = new RegExp(`^ {4}(${METHOD_NAMES.join("|")}):\\s*$`);

export type OpenApiOperation = { path: string; method: string; securityNone: boolean };
export type OpenApiSpec = { base: string; templates: string[]; operations: OpenApiOperation[] };

function extractServerBase(yamlText: string): string {
  const match = /\n {2}- url:\s*(\S+)/.exec(yamlText);
  if (!match) throw new Error("openapi.yaml: no servers[0].url found");
  return match[1]!;
}

/** Scans only the `paths:` block (up to the next top-level key, e.g. `components:`). */
export function parseOpenApi(yamlText: string): OpenApiSpec {
  const base = extractServerBase(yamlText);
  const lines = yamlText.split("\n");
  const pathsStart = lines.indexOf("paths:");
  if (pathsStart === -1) throw new Error("openapi.yaml: no top-level paths: key");
  let pathsEnd = lines.length;
  for (let i = pathsStart + 1; i < lines.length; i++) {
    if (/^[A-Za-z]/.test(lines[i]!)) {
      pathsEnd = i;
      break;
    }
  }
  const operations: OpenApiOperation[] = [];
  const templates = new Set<string>();
  let currentPath: string | null = null;
  let current: OpenApiOperation | null = null;
  const flush = () => {
    if (current) operations.push(current);
    current = null;
  };
  for (const line of lines.slice(pathsStart + 1, pathsEnd)) {
    const pathMatch = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathMatch) {
      flush();
      currentPath = pathMatch[1]!;
      templates.add(currentPath);
      continue;
    }
    const methodMatch = METHOD_RE.exec(line);
    if (methodMatch && currentPath) {
      flush();
      current = { path: currentPath, method: methodMatch[1]!.toUpperCase(), securityNone: false };
      continue;
    }
    if (current && /^\s+security:\s*\[\]\s*$/.test(line)) current.securityNone = true;
  }
  flush();
  return { base, templates: [...templates], operations };
}

/** e.g. base "/api/v1", template "/hosts/{hostId}" -> "/api/v1/hosts/_id_". */
export function resolvedPathname(base: string, template: string): string {
  return base + template.replace(/\{[^}]+\}/g, "_id_");
}

/** True when some documented template resolves to exactly this literal pathname. */
export function isExactlyDocumented(literal: string, base: string, templates: string[]): boolean {
  return templates.some((t) => resolvedPathname(base, t) === literal);
}

/**
 * True when some documented template is this literal path, or a sub-path of it — mirrors
 * auth-policy.ts's own `matchesRoutePrefix`.
 */
export function isPrefixDocumented(literal: string, base: string, templates: string[]): boolean {
  return templates.some((t) => {
    const resolved = resolvedPathname(base, t);
    return resolved === literal || resolved.startsWith(`${literal}/`);
  });
}

/**
 * True when some documented template's shape (read as a regex, `{param}` -> `[^/]+`) matches
 * this concrete example pathname. Used for auth-policy.ts regex branches, which can't be
 * represented as a fixed literal or prefix.
 */
export function isPatternDocumented(example: string, base: string, templates: string[]): boolean {
  return templates.some((t) => {
    const segments = (base + t)
      .split("/")
      .map((segment) =>
        segment.startsWith("{") && segment.endsWith("}")
          ? "[^/]+"
          : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      );
    return new RegExp(`^${segments.join("/")}$`).test(example);
  });
}

/** Every `pathname === "/api/v1/..."` literal in auth-policy.ts's requiredCapability. */
export function extractExactLiterals(authPolicySource: string): string[] {
  return [...authPolicySource.matchAll(/pathname\s*===\s*"(\/api\/v1\/[a-z][^"]*)"/g)].map(
    (m) => m[1]!,
  );
}

/** Every `matchesRoutePrefix(pathname, "/api/v1/...")` literal in auth-policy.ts. */
export function extractPrefixLiterals(authPolicySource: string): string[] {
  return [
    ...authPolicySource.matchAll(/matchesRoutePrefix\(pathname,\s*"(\/api\/v1\/[a-z][^"]*)"\)/g),
  ].map((m) => m[1]!);
}

/**
 * Count of regex-literal branches (`<pattern>.test(pathname)`) in auth-policy.ts — a
 * trip-wire so a newly added regex branch can't silently go unrepresented in the mirrored
 * sample list in scripts/openapi-auth-policy.test.ts.
 */
export function countRegexBranches(authPolicySource: string): number {
  return (authPolicySource.match(/\.test\(pathname\)/g) ?? []).length;
}
