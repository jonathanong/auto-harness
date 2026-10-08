import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultSessionOutputsDir, SessionOutputSpool } from "./session-output-spool.ts";

const temporary: string[] = [];

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "harness-session-output-validation-"));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SessionOutputSpool validation", () => {
  it("uses a private default directory and classifies invalid output files", async () => {
    expect(defaultSessionOutputsDir("/home/tester")).toBe(
      join("/home/tester", ".auto-harness", "session-outputs"),
    );
    const root = await tempDirectory();
    const spool = new SessionOutputSpool({ root });
    const directory = await spool.begin("session-dir", "attempt-dir");
    await mkdir(directory.env.HARNESS_OUTPUT_FILE);
    const tooLarge = await spool.begin("session-large", "attempt-large");
    await writeFile(tooLarge.env.HARNESS_OUTPUT_FILE, Buffer.alloc(256 * 1024 + 1, 32));
    const invalidEncoding = await spool.begin("session-encoding", "attempt-encoding");
    await writeFile(invalidEncoding.env.HARNESS_OUTPUT_FILE, Buffer.from([0xff, 0xfe]));
    await Promise.all([directory.capture(), tooLarge.capture(), invalidEncoding.capture()]);
    const records = await Promise.all(
      ["attempt-dir", "attempt-large", "attempt-encoding"].map(async (attemptId) => {
        const jobs = await readdir(join(root, "jobs"));
        let ready: string | undefined;
        for (const name of jobs.filter((entry) => entry.endsWith(".ready"))) {
          const record = JSON.parse(
            await readFile(join(root, "jobs", name, "job.json"), "utf8"),
          ) as { attemptId: string };
          if (record.attemptId === attemptId) ready = name;
        }
        if (!ready) throw new Error(`missing job for ${attemptId}`);
        return JSON.parse(await readFile(join(root, "jobs", ready, "job.json"), "utf8")) as {
          attemptId: string;
          output: unknown;
        };
      }),
    );
    expect(records.map(({ output }) => output)).toEqual([
      {
        state: "error",
        error: { code: "invalid_output_file", message: "Output path is not a regular file" },
      },
      {
        state: "error",
        error: { code: "output_too_large", message: "Output exceeds 262144 bytes" },
      },
      {
        state: "error",
        error: { code: "invalid_output_encoding", message: "Output must be valid UTF-8" },
      },
    ]);
  });

  it("records unsafe artifact trees without losing valid JSON and rejects a symlinked root", async () => {
    const root = await tempDirectory();
    const outside = await tempDirectory();
    const submissions: unknown[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/outputs/prepare")) {
        submissions.push(JSON.parse(String(init?.body)));
        return Response.json({});
      }
      return Response.json({ ok: true });
    };
    const spool = new SessionOutputSpool({
      root,
      identity: { apiUrl: "http://api.test" },
      fetchFn,
    });
    const unsafeChild = await spool.begin("session-link", "attempt-link");
    await writeFile(unsafeChild.env.HARNESS_OUTPUT_FILE, '{"ok":true}', "utf8");
    await symlink("/etc/passwd", join(unsafeChild.env.HARNESS_ARTIFACTS_DIR, "escape"));
    await unsafeChild.capture();
    await spool.runPass();
    const first = submissions[0] as {
      output: unknown;
      artifacts: { state: string; error?: { code: string } };
    };
    expect(first.output).toMatchObject({ state: "ready" });
    expect(first.artifacts).toMatchObject({
      state: "error",
      error: { code: "artifact_capture_failed" },
    });

    const unsafeRoot = await spool.begin("session-root-link", "attempt-root-link");
    await rm(unsafeRoot.env.HARNESS_ARTIFACTS_DIR, { recursive: true });
    await symlink(outside, unsafeRoot.env.HARNESS_ARTIFACTS_DIR, "dir");
    await writeFile(join(outside, "outside.txt"), "outside", "utf8");
    await unsafeRoot.capture();
    await spool.runPass();
    expect(submissions[1]).toMatchObject({
      artifacts: { state: "error", error: { code: "artifact_capture_failed" } },
    });
  });
});
