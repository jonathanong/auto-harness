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

  it("serializes concurrent page reads without skipping directory entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-attempt-pager-concurrent-"));
    temporary.push(root);
    const directory = join(root, "attempts");
    await mkdir(directory);
    for (let index = 0; index < 4; index += 1)
      await writeFile(join(directory, `attempt-${index}`), "intent", "utf8");
    const expected = await readdir(directory);
    const pager = new SessionOutputAttemptPager();
    const [first, second] = await Promise.all([
      pager.readPage(directory, 2),
      pager.readPage(directory, 2),
    ]);
    expect([...first.names, ...second.names].toSorted()).toEqual(expected.toSorted());
    expect(second.more).toBe(false);
    await pager.close();
  });

  it("propagates a directory-open error other than missing directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-attempt-pager-error-"));
    temporary.push(root);
    const file = join(root, "not-a-directory");
    await writeFile(file, "file", "utf8");
    const pager = new SessionOutputAttemptPager();
    await expect(pager.readPage(file, 10)).rejects.toThrow();
  });

  it("does not retain a directory opened after stop starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-attempt-pager-stop-"));
    temporary.push(root);
    const directory = join(root, "attempts");
    await mkdir(directory);
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        writeFile(join(directory, `attempt-${index}`), "intent", "utf8"),
      ),
    );
    const pager = new SessionOutputAttemptPager();
    const expected = await readdir(directory);
    const pending = pager.readPage(directory, 2);
    const closing = pager.close();
    const result = await pending;
    await closing;
    expect(result.names).toHaveLength(2);
    expect(result.more).toBe(true);
    const reopened: string[] = [];
    let page = await pager.readPage(directory, 2);
    reopened.push(...page.names);
    while (page.more) {
      page = await pager.readPage(directory, 2);
      reopened.push(...page.names);
    }
    expect(reopened.toSorted()).toEqual(expected.toSorted());
    await pager.close();
  });

  it("closes an existing cursor while a later bounded read is in progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-attempt-pager-stop-read-"));
    temporary.push(root);
    const directory = join(root, "attempts");
    await mkdir(directory);
    for (let index = 0; index < 5; index += 1)
      await writeFile(join(directory, `attempt-${index}`), "intent", "utf8");
    const expected = await readdir(directory);
    const pager = new SessionOutputAttemptPager();
    const first = await pager.readPage(directory, 1);
    expect(first.more).toBe(true);

    const pending = pager.readPage(directory, 10);
    const closing = pager.close();
    const result = await pending;
    await closing;
    expect([...first.names, ...result.names].toSorted()).toEqual(expected.toSorted());
    expect(result.more).toBe(false);
    const reopened: string[] = [];
    let page = await pager.readPage(directory, 2);
    reopened.push(...page.names);
    while (page.more) {
      page = await pager.readPage(directory, 2);
      reopened.push(...page.names);
    }
    expect(reopened.toSorted()).toEqual(expected.toSorted());
    await pager.close();
  });
});
