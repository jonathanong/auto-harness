import { describe, expect, it } from "vitest";

import { DeleteObjectsCommand, ListObjectVersionsCommand } from "@aws-sdk/client-s3";

import { deleteSessionObjectVersionsPage } from "./session-object-retention.ts";

type S3Command = ListObjectVersionsCommand | DeleteObjectsCommand;

function commandInput<T extends S3Command>(
  command: unknown,
  kind: new (...args: never[]) => T,
): T["input"] {
  if (!(command instanceof kind)) throw new Error(`expected ${kind.name}`);
  return command.input;
}

describe("deleteSessionObjectVersionsPage", () => {
  it("deletes a bounded set of versions and delete markers under one session prefix", async () => {
    const commands: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof ListObjectVersionsCommand) {
          return {
            Versions: [
              { Key: "sessions/sess-1/parts/1-5.jsonl.gz", VersionId: "v1" },
              { Key: "sessions/sess-1/logs.jsonl.gz", VersionId: "v2" },
            ],
            DeleteMarkers: [{ Key: "sessions/sess-1/logs.jsonl.gz", VersionId: "marker-1" }],
            IsTruncated: true,
          };
        }
        return {};
      },
    };

    await expect(deleteSessionObjectVersionsPage(client, "archives", "sess-1", 3)).resolves.toEqual(
      {
        deleted: 3,
        done: false,
      },
    );
    expect(commands).toHaveLength(2);
    expect(commandInput(commands[0], ListObjectVersionsCommand)).toEqual({
      Bucket: "archives",
      Prefix: "sessions/sess-1/",
      MaxKeys: 3,
    });
    expect(commandInput(commands[1], DeleteObjectsCommand)).toEqual({
      Bucket: "archives",
      Delete: {
        Objects: [
          { Key: "sessions/sess-1/parts/1-5.jsonl.gz", VersionId: "v1" },
          { Key: "sessions/sess-1/logs.jsonl.gz", VersionId: "v2" },
          { Key: "sessions/sess-1/logs.jsonl.gz", VersionId: "marker-1" },
        ],
        Quiet: true,
      },
    });
  });

  it("caps S3 pages at 1000 and treats a fresh empty page as completion", async () => {
    let listed: unknown;
    const client = {
      send: async (command: unknown) => {
        listed = command;
        return { IsTruncated: false };
      },
    };
    await expect(
      deleteSessionObjectVersionsPage(client, "archives", "sess", 5000),
    ).resolves.toEqual({
      deleted: 0,
      done: true,
    });
    expect(commandInput(listed, ListObjectVersionsCommand).MaxKeys).toBe(1000);
  });

  it("resumes by listing the first remaining prefix page after each delete", async () => {
    const remaining = ["v1", "v2"];
    const commands: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof ListObjectVersionsCommand) {
          const versionId = remaining[0];
          return versionId
            ? {
                Versions: [{ Key: "sessions/sess/parts/1-1.jsonl.gz", VersionId: versionId }],
                IsTruncated: true,
              }
            : { IsTruncated: false };
        }
        const input = commandInput(command, DeleteObjectsCommand);
        remaining.shift();
        expect(input.Delete?.Objects).toHaveLength(1);
        return {};
      },
    };

    await expect(deleteSessionObjectVersionsPage(client, "archives", "sess", 1)).resolves.toEqual({
      deleted: 1,
      done: false,
    });
    await expect(deleteSessionObjectVersionsPage(client, "archives", "sess", 1)).resolves.toEqual({
      deleted: 1,
      done: false,
    });
    await expect(deleteSessionObjectVersionsPage(client, "archives", "sess", 1)).resolves.toEqual({
      deleted: 0,
      done: true,
    });
    expect(commands.filter((command) => command instanceof ListObjectVersionsCommand)).toHaveLength(
      3,
    );
    for (const command of commands.filter((item) => item instanceof ListObjectVersionsCommand)) {
      expect(commandInput(command, ListObjectVersionsCommand)).toEqual({
        Bucket: "archives",
        Prefix: "sessions/sess/",
        MaxKeys: 1,
      });
    }
  });

  it("fails closed for invalid ids, limits, out-of-prefix objects, malformed entries, and oversized pages", async () => {
    const noSend = { send: async () => ({}) };
    for (const [sessionId, limit] of [
      ["", 1],
      ["nested/session", 1],
      ["sess", 0],
      ["sess", 1.5],
    ] as const) {
      await expect(
        deleteSessionObjectVersionsPage(noSend, "archives", sessionId, limit),
      ).rejects.toThrow("invalid session object deletion page");
    }

    for (const entry of [
      { Key: "sessions/sess-elsewhere/logs.jsonl.gz", VersionId: "v1" },
      { Key: "sessions/sess/unexpected.txt", VersionId: "v1" },
      { Key: "sessions/sess/logs.jsonl.gz" },
      { VersionId: "v1" },
    ]) {
      await expect(
        deleteSessionObjectVersionsPage(
          { send: async () => ({ Versions: [entry] }) },
          "archives",
          "sess",
          1,
        ),
      ).rejects.toThrow("refusing an invalid session object version");
    }
    await expect(
      deleteSessionObjectVersionsPage(
        {
          send: async () => ({
            Versions: [
              { Key: "sessions/sess/logs.jsonl.gz", VersionId: "v1" },
              { Key: "sessions/sess/logs.jsonl.gz", VersionId: "v2" },
            ],
          }),
        },
        "archives",
        "sess",
        1,
      ),
    ).rejects.toThrow("object version listing exceeded its limit");
  });

  it("fails closed for an empty truncated listing and partial DeleteObjects errors", async () => {
    await expect(
      deleteSessionObjectVersionsPage(
        { send: async () => ({ IsTruncated: true }) },
        "archives",
        "sess",
        10,
      ),
    ).rejects.toThrow("empty truncated page");
    await expect(
      deleteSessionObjectVersionsPage(
        {
          send: async (command) =>
            command instanceof ListObjectVersionsCommand
              ? { Versions: [{ Key: "sessions/sess/logs.jsonl.gz", VersionId: "v1" }] }
              : { Errors: [{ Key: "sessions/sess/logs.jsonl.gz", Code: "AccessDenied" }] },
        },
        "archives",
        "sess",
        10,
      ),
    ).rejects.toThrow("session object version deletion was incomplete");
  });
});
