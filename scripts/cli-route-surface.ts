import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const API_SRC = fileURLToPath(new URL("../services/api/src/", import.meta.url));

/** Handler sources for the local/Lambda app. Tests are excluded so fixtures cannot widen the surface. */
export function readRouteSourceFiles(): string[] {
  const names = readdirSync(API_SRC).filter(
    (name) =>
      (name === "local-app.ts" || name.startsWith("local-routes-")) &&
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts"),
  );
  return names.map((name) => readFileSync(join(API_SRC, name), "utf8"));
}

export function readRouteSources(): string {
  return readRouteSourceFiles().join("\n");
}

export function stripRouteComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Expand the route-regex subset used by local-routes into concrete `/api/v1/...` templates. */
export function expandRoutePattern(pattern: string): string[] {
  let index = 0;
  const results = parseAlternation();
  if (index !== pattern.length) {
    throw new Error(`unparsed route pattern at ${index}: ${pattern}`);
  }
  return results.filter((path) => path.length > 0);

  function peek(text: string): boolean {
    return pattern.startsWith(text, index);
  }

  function parseAlternation(): string[] {
    const options = [parseConcatenation()];
    while (pattern[index] === "|") {
      index += 1;
      options.push(parseConcatenation());
    }
    return options.flat();
  }

  function parseConcatenation(): string[] {
    let paths = [""];
    while (index < pattern.length && pattern[index] !== ")" && pattern[index] !== "|") {
      const next = parseAtom();
      const combined: string[] = [];
      for (const left of paths) {
        for (const right of next) combined.push(left + right);
      }
      paths = combined;
    }
    return paths;
  }

  function parseAtom(): string[] {
    const start = index;
    if (peek("(?:") || pattern[index] === "(") {
      index += peek("(?:") ? 3 : 1;
      const inner = parseAlternation();
      if (pattern[index] !== ")") throw new Error(`unclosed group in ${pattern}`);
      index += 1;
      if (pattern[index] === "?") {
        index += 1;
        return ["", ...inner];
      }
      return inner;
    }
    if (peek("[^/]+")) {
      index += "[^/]+".length;
      return ["{}"];
    }
    let literal = "";
    while (
      index < pattern.length &&
      pattern[index] !== "(" &&
      pattern[index] !== ")" &&
      pattern[index] !== "|" &&
      pattern[index] !== "?" &&
      !peek("[^/]+") &&
      !peek("(?:")
    ) {
      const current = pattern[index];
      if (current === "\\") {
        const escaped = pattern[index + 1];
        if (escaped === undefined) throw new Error(`dangling escape in ${pattern}`);
        literal += escaped;
        index += 2;
        continue;
      }
      if (current === "^" || current === "$") {
        index += 1;
        continue;
      }
      if (current === undefined) break;
      literal += current;
      index += 1;
    }
    if (index === start) throw new Error(`stuck at ${index} in ${pattern}`);
    return [literal];
  }
}

export function extractRouteTemplates(source: string): Set<string> {
  const text = stripRouteComments(source);
  const templates = new Set<string>();
  for (const body of regexBodies(text)) {
    for (const path of expandRoutePattern(body)) templates.add(path);
  }
  for (const match of text.matchAll(/["'](\/api\/v1\/[^"']+|\/health)["']/g)) {
    const path = match[1];
    if (path && !path.endsWith("/")) templates.add(path);
  }
  return templates;
}

type RegexHit = { start: number; end: number; body: string };

export function regexHits(source: string): RegexHit[] {
  const hits: RegexHit[] = [];
  const marker = "/^\\/api\\/v1";
  let from = 0;
  while (from < source.length) {
    const start = source.indexOf(marker, from);
    if (start === -1) break;
    let index = start + 1;
    let body = "";
    let closed = false;
    while (index < source.length) {
      const current = source[index];
      if (current === "\\") {
        body += current + (source[index + 1] ?? "");
        index += 2;
        continue;
      }
      if (current === "[") {
        const end = source.indexOf("]", index);
        if (end === -1) throw new Error("unclosed character class");
        body += source.slice(index, end + 1);
        index = end + 1;
        continue;
      }
      if (current === "/") {
        hits.push({ start, end: index, body });
        from = index + 1;
        closed = true;
        break;
      }
      body += current ?? "";
      index += 1;
    }
    if (!closed) throw new Error(`unclosed route regex near ${source.slice(start, start + 80)}`);
  }
  return hits;
}

function regexBodies(source: string): string[] {
  return regexHits(source).map((hit) => hit.body);
}

export function extractExactMethodPaths(source: string): Set<string> {
  const text = inlinePathConstants(stripRouteComments(source));
  const pairs = new Set<string>();
  const patterns = [
    /method === "([A-Z]+)" && [^|\n]{0,100}?pathname === "([^"]+)"/g,
    /pathname === "([^"]+)" && [^|\n]{0,100}?method === "([A-Z]+)"/g,
    /method !== "([A-Z]+)" \|\| [^&\n]{0,100}?pathname !== "([^"]+)"/g,
    /pathname !== "([^"]+)" \|\| [^&\n]{0,100}?method !== "([A-Z]+)"/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const method = pattern.source.startsWith("pathname") ? match[2] : match[1];
      const path = pattern.source.startsWith("pathname") ? match[1] : match[2];
      if (method && path) pairs.add(`${method} ${path}`);
    }
  }
  return pairs;
}

function inlinePathConstants(source: string): string {
  let text = source;
  for (const match of source.matchAll(/const ([A-Z][A-Z0-9_]*) = "(\/api\/v1\/[^"]+|\/health)"/g)) {
    const name = match[1];
    const path = match[2];
    if (!name || !path) continue;
    text = text.replaceAll(new RegExp(`\\b${name}\\b`, "g"), JSON.stringify(path));
  }
  return text;
}
