import { Readable } from "node:stream";

/** Builds an in-memory `io` for CLI tests: captures stdout/stderr into strings, serves
 * `readFile`/`writeFileExclusive` from an in-memory `files` map, and feeds `stdin` from
 * `stdinText` (or empty). `writeFileExclusiveCalls` records every `writeFileExclusive` call
 * (including its `options`, e.g. `{ mode: 0o600 }`) for tests that assert on it directly. */
export function makeIo({ env = {}, fetch, files = {}, stdinText } = {}) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const writeFileExclusiveCalls = [];
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
    writeFileExclusive: async (path, data, options) => {
      if (Object.hasOwn(files, path)) {
        throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), {
          code: "EEXIST",
        });
      }
      writeFileExclusiveCalls.push({ path, data, options });
      files[path] = data;
    },
  };
  return {
    io,
    stdout: () => stdoutChunks.join(""),
    stderr: () => stderrChunks.join(""),
    writeFileExclusiveCalls,
  };
}
