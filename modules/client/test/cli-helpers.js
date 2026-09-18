import { Readable } from "node:stream";

/** Builds an in-memory `io` for CLI tests: captures stdout/stderr into strings, serves
 * `readFile` from an in-memory `files` map, and feeds `stdin` from `stdinText` (or empty). */
export function makeIo({ env = {}, fetch, files = {}, stdinText } = {}) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const io = {
    env,
    fetch:
      fetch ??
      (async () => {
        throw new Error("unexpected fetch call in test");
      }),
    stdout: { write: (chunk) => stdoutChunks.push(chunk) },
    stderr: { write: (chunk) => stderrChunks.push(chunk) },
    stdin: Readable.from(stdinText === undefined ? [] : [stdinText]),
    readFile: async (path) => {
      if (!Object.hasOwn(files, path)) {
        throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: "ENOENT" });
      }
      return files[path];
    },
  };
  return { io, stdout: () => stdoutChunks.join(""), stderr: () => stderrChunks.join("") };
}
