#!/usr/bin/env node
import { readFile } from "node:fs/promises";

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
};

process.exitCode = await main(process.argv.slice(2), io);
