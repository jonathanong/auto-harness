import { ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { compactSessionArgvPage } from "./db/session-argv-compaction.ts";

const PROMPT = "Fix the flaky test.";

function fakeDynamo(rows: Record<string, unknown>[], failUpdate?: (id: unknown) => Error) {
  const updates: unknown[] = [];
  const doc = {
    send: async (command: unknown) => {
      if (command instanceof ScanCommand) {
        const start = (command.input.ExclusiveStartKey?.id as number | undefined) ?? 0;
        const items = rows.slice(start, start + 2);
        return {
          Items: items,
          LastEvaluatedKey: start + 2 < rows.length ? { id: start + 2 } : {},
        };
      }
      const update = (command as UpdateCommand).input;
      const failure = failUpdate?.(update.Key?.id);
      if (failure) throw failure;
      updates.push(update);
      return {};
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, updates };
}

describe("session argv compaction", () => {
  it("rewrites only legacy rows that repeat the prompt, page by page", async () => {
    const { doc, updates } = fakeDynamo([
      { id: "legacy", prompt: PROMPT, resolvedArgv: ["claude", "-p", PROMPT] },
      { id: "compacted", prompt: PROMPT, resolvedArgv: ["claude", { before: "", after: "" }] },
      { id: "no-prompt-arg", prompt: PROMPT, resolvedArgv: ["tool", "run"] },
      { id: "empty-prompt", prompt: "", resolvedArgv: ["tool"] },
      { id: "queued", prompt: PROMPT },
    ]);
    const first = await compactSessionArgvPage(doc, { sessions: "Sessions" });
    expect(first).toEqual({ compacted: 1, nextKey: { id: 2 } });
    const second = await compactSessionArgvPage(doc, { sessions: "Sessions" }, first.nextKey);
    const third = await compactSessionArgvPage(doc, { sessions: "Sessions" }, second.nextKey);
    expect([second, third]).toEqual([
      { compacted: 0, nextKey: { id: 4 } },
      { compacted: 0, nextKey: undefined },
    ]);
    expect(updates).toEqual([
      expect.objectContaining({
        Key: { id: "legacy" },
        ConditionExpression: "#prompt = :prompt AND resolvedArgv = :argv",
        ExpressionAttributeValues: {
          ":stored": ["claude", "-p", { before: "", after: "" }],
          ":prompt": PROMPT,
          ":argv": ["claude", "-p", PROMPT],
        },
      }),
    ]);
  });

  it("leaves a row changed since the scan to its writer and rethrows other failures", async () => {
    const rows = [
      { id: "changed", prompt: PROMPT, resolvedArgv: [PROMPT] },
      { id: "broken", prompt: PROMPT, resolvedArgv: [PROMPT] },
    ];
    const conditional = Object.assign(new Error("changed"), {
      name: "ConditionalCheckFailedException",
    });
    const changed = fakeDynamo(rows.slice(0, 1), () => conditional);
    await expect(compactSessionArgvPage(changed.doc, { sessions: "Sessions" })).resolves.toEqual({
      compacted: 0,
      nextKey: undefined,
    });
    const broken = fakeDynamo(rows.slice(1), () => new Error("throttled"));
    await expect(compactSessionArgvPage(broken.doc, { sessions: "Sessions" })).rejects.toThrow(
      "throttled",
    );
  });
});
