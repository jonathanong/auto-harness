import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionOutputAttemptPager } from "./session-output-attempt-pager.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SessionOutputAttemptPager", () => {
  it("returns bounded pages, wraps after EOF, and reopens after close", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-attempt-pager-"));
    temporary.push(root);
    const directory = join(root, "attempts");
    await mkdir(directory);
    for (let index = 0; index < 5; index += 1)
      await writeFile(join(directory, `attempt-${index}`), "intent", "utf8");
    const expected = await readdir(directory);
    const pager = new SessionOutputAttemptPager();

    const first = await pager.readPage(directory, 2);
    const second = await pager.readPage(directory, 2);
    const final = await pager.readPage(directory, 2);
    expect(first).toMatchObject({ more: true });
    expect(second).toMatchObject({ more: true });
    expect(final).toMatchObject({ more: false });
    expect([...first.names, ...second.names, ...final.names].toSorted()).toEqual(
      expected.toSorted(),
    );

    const wrapped = await pager.readPage(directory, 2);
    expect(wrapped.names).toEqual(first.names);
    await pager.close();
    expect(await pager.readPage(directory, 2)).toEqual({ names: first.names, more: true });
    await pager.close();
  });

  it("treats a missing attempts directory as an empty page", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-attempt-pager-empty-"));
    temporary.push(root);
    const pager = new SessionOutputAttemptPager();
    await expect(pager.readPage(join(root, "missing"), 100)).resolves.toEqual({
      names: [],
      more: false,
    });
    await pager.close();
  });

  it("closes a persistent directory cursor at an exact page boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-attempt-pager-boundary-"));
    temporary.push(root);
    const directory = join(root, "attempts");
    await mkdir(directory);
    await writeFile(join(directory, "one"), "intent", "utf8");
    await writeFile(join(directory, "two"), "intent", "utf8");
    const pager = new SessionOutputAttemptPager();
    const page = await pager.readPage(directory, 2);
    expect(page.names).toHaveLength(2);
    expect(page.more).toBe(false);
  });

  it("propagates a directory-open error other than missing directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-attempt-pager-error-"));
    temporary.push(root);
    const file = join(root, "not-a-directory");
    await writeFile(file, "file", "utf8");
    const pager = new SessionOutputAttemptPager();
    await expect(pager.readPage(file, 10)).rejects.toThrow();
  });

  it("closes the cursor when stop races an in-progress bounded read", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-attempt-pager-stop-"));
    temporary.push(root);
    const directory = join(root, "attempts");
    await mkdir(directory);
    await Promise.all(
      Array.from({ length: 4_000 }, (_, index) =>
        writeFile(join(directory, `attempt-${index}`), "intent", "utf8"),
      ),
    );
    const pager = new SessionOutputAttemptPager();
    const pending = pager.readPage(directory, 10_000);
    const observed = pending.then(
      () => ({ rejected: false, error: undefined }),
      (error: unknown) => ({ rejected: true, error }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await pager.close();
    const result = await observed;
    expect(result.rejected).toBe(true);
    expect(result.error).toMatchObject({ code: "ERR_DIR_CLOSED" });
  });
});
