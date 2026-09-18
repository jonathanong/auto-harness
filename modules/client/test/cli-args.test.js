import assert from "node:assert/strict";
import test from "node:test";

import { parseFlags } from "../src/cli/args.js";
import { CliUsageError } from "../src/cli/cli-errors.js";

test("parses value and boolean flags mixed with positionals", () => {
  const { flags, positionals } = parseFlags(
    ["api", "GET", "/hosts", "--allow-insecure-http", "--api-url", "http://x"],
    { valueFlags: ["--api-url"], booleanFlags: ["--allow-insecure-http"] },
  );
  assert.deepEqual(positionals, ["api", "GET", "/hosts"]);
  assert.deepEqual(flags, { "--allow-insecure-http": true, "--api-url": "http://x" });
});

test("supports --name=value inline flags", () => {
  const { flags } = parseFlags(["--api-url=https://x"], { valueFlags: ["--api-url"] });
  assert.equal(flags["--api-url"], "https://x");
});

test("rejects a boolean flag given an inline value", () => {
  assert.throws(
    () => parseFlags(["--allow-insecure-http=true"], { booleanFlags: ["--allow-insecure-http"] }),
    CliUsageError,
  );
});

test("rejects --api-key given as a separate argument", () => {
  assert.throws(
    () => parseFlags(["--api-key", "secret"], {}),
    (error) => {
      assert.ok(error instanceof CliUsageError);
      assert.match(error.message, /HARNESS_API_KEY/);
      return true;
    },
  );
});

test("rejects --api-key=<value> without leaking the value", () => {
  assert.throws(
    () => parseFlags(["--api-key=super-secret-token"], {}),
    (error) => {
      assert.ok(error instanceof CliUsageError);
      assert.ok(!error.message.includes("super-secret-token"));
      assert.match(error.message, /HARNESS_API_KEY/);
      return true;
    },
  );
});

test("rejects an unknown flag without leaking an inline value", () => {
  assert.throws(
    () => parseFlags(["--mystery=leaked-value"], {}),
    (error) => {
      assert.ok(error instanceof CliUsageError);
      assert.equal(error.message, "unknown flag: --mystery");
      return true;
    },
  );
});

test("requires a value for a value flag", () => {
  assert.throws(() => parseFlags(["--api-url"], { valueFlags: ["--api-url"] }), CliUsageError);
});
