/**
 * Setup-script output travels through a plain pipe (`SpawnProcessRunner`), so a
 * bare `\n` is never translated into `\r\n`. The agent command instead runs
 * under a PTY (`PtyProcessRunner`), whose ONLCR translation does that for
 * free. xterm.js needs the CR to return the cursor to column 0, so without
 * this, setup output staircases one column to the right on every line while
 * the agent command's output does not.
 *
 * A stateless per-chunk regex would double a `\r\n` pair split across two
 * chunks: a chunk ending in a lone `\r` followed by a chunk starting with
 * `\n` is one CRLF, not a bare `\r` plus a bare `\n`. Track whether the
 * previous chunk on a stream ended with `\r` so that boundary is not
 * corrupted into `\r\r\n`.
 */
export function createCrlfNormalizer(): (stream: string, data: string) => string {
  const endedWithCR = new Map<string, boolean>();
  return (stream, data) => {
    if (data.length === 0) return data;
    const precededByCR = endedWithCR.get(stream) ?? false;
    endedWithCR.set(stream, data.endsWith("\r"));
    if (precededByCR && data.startsWith("\n")) {
      return data[0] + normalizeBareLineFeeds(data.slice(1));
    }
    return normalizeBareLineFeeds(data);
  };
}

function normalizeBareLineFeeds(data: string): string {
  return data.replace(/(?<!\r)\n/g, "\r\n");
}
