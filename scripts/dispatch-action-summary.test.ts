import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  closeDispatchActionServers,
  drainInputs,
  inputEnvName,
  runActionWithEnv,
  serve,
} from "./test-helpers/dispatch-action-test-helpers.ts";

afterEach(closeDispatchActionServers);

const session = {
  created: true,
  concurrencyId: "github-42",
  id: "session-1",
  target: { providerId: "codex" },
  url: "https://example.test/sessions/session-1",
};

const dispatchInputs = (origin: string, concurrencyId = "github-42") => ({
  ...drainInputs(origin, "dispatch"),
  ...(concurrencyId ? { "concurrency-id": concurrencyId } : {}),
  prompt: "review",
  target: '{"providerId":"codex"}',
  timeout: "300",
});

describe("dispatch action step summary", () => {
  it("writes a step summary and notice for a dispatched session", async () => {
    const server = await serve(() => ({ body: session }));
    const directory = await mkdtemp(join(tmpdir(), "auto-harness-dispatch-summary-"));
    const summary = join(directory, "summary.md");

    const result = await runActionWithEnv({
      ...Object.fromEntries(
        Object.entries(dispatchInputs(server.origin)).map(([name, value]) => [
          inputEnvName(name),
          value,
        ]),
      ),
      GITHUB_STEP_SUMMARY: summary,
    });
    const text = await readFile(summary, "utf8");
    await rm(directory, { force: true, recursive: true });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "::notice title=Auto Harness::Dispatched session session-1: https://example.test/sessions/session-1",
    );
    expect(text).toContain("### Dispatched Auto Harness session");
    expect(text).toContain("- Session: [`session-1`](https://example.test/sessions/session-1)");
    expect(text).toContain("- Created: yes");
    expect(text).toContain('- Provider route: `{"providerId":"codex"}`');
    expect(text).toContain("- Concurrency ID: `github-42`");
  });

  it("neutralizes backticks and newlines and omits absent fields", async () => {
    const server = await serve(() => ({
      body: { created: false, id: "a`b", url: "https://example.test/s/(x)" },
    }));
    const directory = await mkdtemp(join(tmpdir(), "auto-harness-dispatch-summary-"));
    const summary = join(directory, "summary.md");

    const result = await runActionWithEnv({
      [inputEnvName("api-key")]: "test-key",
      [inputEnvName("operation")]: "resume",
      [inputEnvName("server-url")]: server.origin,
      [inputEnvName("session-id")]: "session-1",
      GITHUB_STEP_SUMMARY: summary,
    });
    const text = await readFile(summary, "utf8");
    await rm(directory, { force: true, recursive: true });

    expect(result.code).toBe(0);
    expect(text).toContain("### Resumed Auto Harness session");
    expect(text).toContain("- Session: [`a'b`](https://example.test/s/%28x%29)");
    expect(text).toContain("- Created: no (existing session)");
    expect(text).not.toContain("Provider route");
    expect(text).not.toContain("Concurrency ID");
  });

  it("warns instead of failing when the step summary cannot be written", async () => {
    const server = await serve(() => ({ body: session }));
    const directory = await mkdtemp(join(tmpdir(), "auto-harness-dispatch-summary-"));

    const result = await runActionWithEnv({
      ...Object.fromEntries(
        Object.entries(dispatchInputs(server.origin)).map(([name, value]) => [
          inputEnvName(name),
          value,
        ]),
      ),
      // A directory cannot be appended to, so the summary write throws.
      GITHUB_STEP_SUMMARY: directory,
    });
    await rm(directory, { force: true, recursive: true });

    expect(result.code).toBe(0);
    expect(result.output["session-id"]).toBe("session-1");
    expect(result.stdout).toContain("::warning::Could not write the step summary:");
  });
});
