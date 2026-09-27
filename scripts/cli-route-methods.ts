import { expandRoutePattern, regexHits, stripRouteComments } from "./cli-route-surface.ts";

const METHOD_CHECK = /(?:ctx\.)?method (?:===|!==) "(GET|POST|PUT|PATCH|DELETE)"/g;

/**
 * Methods checked beside a parameterized route. Adjacent regexes with no method
 * check between them share the following checks, and the scan stops at the next
 * regex or at a literal pathname comparison so a later exact route is not blamed
 * on this template. A method must then be covered by one of those templates.
 */
export function extractRegexMethodBindings(
  source: string,
): Array<{ method: string; paths: string[] }> {
  const text = stripRouteComments(source);
  const hits = regexHits(text);
  const bindings: Array<{ method: string; paths: string[] }> = [];
  let index = 0;
  while (index < hits.length) {
    let end = index + 1;
    while (
      end < hits.length &&
      !METHOD_CHECK.test(text.slice(hits[end - 1]?.end ?? 0, hits[end]?.start ?? 0))
    ) {
      METHOD_CHECK.lastIndex = 0;
      end += 1;
    }
    METHOD_CHECK.lastIndex = 0;
    const cluster = hits.slice(index, end);
    const last = cluster.at(-1);
    const next = hits[end];
    if (last) {
      const region = text.slice(last.end, next?.start ?? text.length);
      const stop = region.search(/pathname (?:===|!==) "/);
      const methods = new Set<string>();
      METHOD_CHECK.lastIndex = 0;
      for (const match of region.slice(0, stop === -1 ? undefined : stop).matchAll(METHOD_CHECK)) {
        const method = match[1];
        if (method) methods.add(method);
      }
      const paths = [...new Set(cluster.flatMap((hit) => expandRoutePattern(hit.body)))];
      for (const method of methods) bindings.push({ method, paths });
    }
    index = end;
  }
  return bindings;
}
