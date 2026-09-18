#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

import { main } from "./main.js";

// A thin wrapper: every dependency on the outside world is injected here, so `main()` and
// everything it calls stay unit-testable without spawning a process or touching the network.
const io = {
  env: process.env,
  fetch: globalThis.fetch,
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  readFile,
  // O_CREAT | O_EXCL ("wx") — never overwrites an existing file. Used only for
  // `service-account create --key-file`, where a plaintext API key is written to disk exactly
  // once and mode 0600 (passed by the caller) keeps it readable only by its owner.
  writeFileExclusive: (path, data, options) => writeFile(path, data, { flag: "wx", ...options }),
};

process.exitCode = await main(process.argv.slice(2), io);
