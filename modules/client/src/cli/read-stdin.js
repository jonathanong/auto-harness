/** Reads an injected `stdin` (any async-iterable of `Buffer`/`string` chunks — the real
 * `process.stdin`, or a `Readable.from([...])` in tests) fully into a UTF-8 string. */
export async function readStdin(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
