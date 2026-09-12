/* eslint-disable max-lines -- child validation, durable admission, and cursor paging share one contract. */
import { createHash } from "node:crypto";
import {
  isActiveSessionStatus,
  isTerminalSessionStatus,
  sessionPriorityError,
} from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";
import { noteSlackSessionLifecycle, toPublic } from "./control-plane-state.ts";
import { buildSessionRecord, validateSessionCreate } from "./control-plane-session-create.ts";
import { getSessionDurable } from "./control-plane-durable-read-runtime.ts";
import {
  getRepositoryDurable,
  refreshTargetCatalogDurable,
} from "./control-plane-durable-read-catalog.ts";
import { referenceMarkers } from "./control-plane-delete-reference-markers.ts";
import {
  isCreateSessionConflict,
  MAX_SESSION_DESCENDANTS,
  isRepositoryAdmissionClosed,
  sessionDrainOperationId,
} from "./db/plane-storage-sessions.ts";
import type { SessionRecord } from "./db/types.ts";
import {
  decodeStorageCursor,
  encodeStorageCursor,
  type ListPage,
} from "./control-plane-id-page.ts";

const SPAWN_KEY_MAX_BYTES = 256;

type ChildResult =
  | { ok: true; session: import("./control-plane-types.ts").PublicSession; created: boolean }
  | { ok: false; error: string; code?: string; operationId?: string };

function childInput(
  parent: SessionRecord,
  body: unknown,
): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be an object" };
  }
  const record = body as Record<string, unknown>;
  const permitted = new Set(["prompt", "spawnKey", "priority", "queueTtlSeconds"]);
  if (Object.keys(record).some((key) => !permitted.has(key))) {
    return {
      ok: false,
      error: "child sessions only accept prompt, spawnKey, priority, and queueTtlSeconds",
    };
  }
  if (typeof record.prompt !== "string" || record.prompt.length === 0) {
    return { ok: false, error: "prompt is required" };
  }
  if (
    typeof record.spawnKey !== "string" ||
    record.spawnKey.length === 0 ||
    Buffer.byteLength(record.spawnKey, "utf8") > SPAWN_KEY_MAX_BYTES ||
    [...record.spawnKey].some(
      (character) => character.codePointAt(0)! < 0x20 || character === "\x7f",
    )
  ) {
    return {
      ok: false,
      error: "spawnKey must be a non-empty printable string of at most 256 bytes",
    };
  }
  if (record.priority !== undefined && sessionPriorityError(record.priority)) {
    return { ok: false, error: sessionPriorityError(record.priority)! };
  }
  if (
    record.queueTtlSeconds !== undefined &&
    (!Number.isInteger(record.queueTtlSeconds) ||
      (record.queueTtlSeconds as number) <= 0 ||
      (record.queueTtlSeconds as number) > 30 * 24 * 60 * 60)
  ) {
    return { ok: false, error: "queueTtlSeconds must be a positive integer at most 2592000" };
  }
  return {
    ok: true,
    input: {
      repositoryId: parent.repositoryId,
      prompt: record.prompt,
      target: parent.target,
      fallbacks: parent.fallbacks,
      timeout: parent.timeout,
      priority: record.priority ?? parent.priority,
      queueTtlSeconds: record.queueTtlSeconds ?? parent.queueTtlSeconds,
      requiredLabels: parent.requiredLabels,
      ...(parent.ref !== undefined ? { ref: parent.ref } : {}),
      type: "prompt",
      source: "api",
      // Raw spawn keys can be user/task text. Keep only an opaque deterministic
      // digest in the active-only idempotency lock and never on the session row.
      concurrencyId: `session-spawn:${parent.id}:${createHash("sha256").update(record.spawnKey).digest("hex")}`,
    },
  };
}

function prepareChild(
  state: ControlPlaneState,
  parent: SessionRecord,
  body: unknown,
): { ok: true; child: SessionRecord } | { ok: false; error: string; code?: string } {
  if (parent.status !== "running" && !isTerminalSessionStatus(parent.status)) {
    return { ok: false, error: "parent session must be running or terminal", code: "CONFLICT" };
  }
  const input = childInput(parent, body);
  if (!input.ok) return input;
  const prepared = validateSessionCreate(state, input.input, { allowReservedConcurrencyId: true });
  if (!prepared.ok) return prepared;
  const child = buildSessionRecord(state, prepared, parent.principalId);
  child.parentSessionId = parent.id;
  child.rootSessionId = parent.rootSessionId ?? parent.id;
  return { ok: true, child };
}

export async function createSessionChildDurable(
  state: ControlPlaneState,
  parentId: string,
  body: unknown,
  options: { principalId?: string; sessionCredentialHash?: string } = {},
): Promise<ChildResult> {
  const parent = state.storage
    ? await getSessionDurable(state, parentId)
    : state.sessions.get(parentId);
  if (!parent) return { ok: false, error: "parent session not found", code: "NOT_FOUND" };
  if (state.storage) {
    await Promise.all([
      getRepositoryDurable(state, parent.repositoryId),
      refreshTargetCatalogDurable(state),
    ]);
  }
  const prepared = prepareChild(state, parent, body);
  if (!prepared.ok) return prepared;
  const rootId = prepared.child.rootSessionId ?? parent.id;
  const owner = options.principalId ?? parent.principalId ?? parent.metadata?.createdBy;
  if (typeof owner === "string" && owner) {
    prepared.child.principalId = owner;
    prepared.child.metadata = { createdBy: owner };
  }
  if (!state.storage) {
    const duplicate = [...state.sessions.values()].find(
      (session) =>
        session.concurrencyId === prepared.child.concurrencyId &&
        isActiveSessionStatus(session.status),
    );
    if (duplicate) return { ok: true, session: toPublic(state, duplicate), created: false };
    const root = state.sessions.get(rootId);
    const descendantCount = root?.descendantCount ?? 0;
    if (!root || descendantCount >= MAX_SESSION_DESCENDANTS) {
      return {
        ok: false,
        error: "root session descendant budget is exhausted",
        code: "CONFLICT",
      };
    }
    // A session credential is only valid for the exact active attempt which
    // received it. Re-read immediately before the local insert so a terminal
    // transition between request authentication and admission cannot mint a
    // child after the parent has exited.
    if (options.sessionCredentialHash) {
      const current = state.sessions.get(parentId);
      if (
        !current ||
        current.status !== "running" ||
        current.sessionApiKeyHash !== options.sessionCredentialHash
      ) {
        return {
          ok: false,
          error: "parent session attempt is no longer running",
          code: "CONFLICT",
        };
      }
    }
    state.sessions.set(prepared.child.id, { ...prepared.child });
    root.descendantCount = descendantCount + 1;
    return { ok: true, session: toPublic(state, prepared.child), created: true };
  }
  try {
    const result = await state.storage.createSession(
      prepared.child,
      referenceMarkers(state.now(), prepared.child),
      {
        id: parentId,
        rootSessionId: rootId,
        ...(options.sessionCredentialHash
          ? { sessionApiKeyHash: options.sessionCredentialHash }
          : {}),
      },
    );
    state.sessions.set(result.session.id, { ...result.session });
    if (result.created) noteSlackSessionLifecycle(state, result.session);
    return { ok: true, session: toPublic(state, result.session), created: result.created };
  } catch (error) {
    const operationId = sessionDrainOperationId(error);
    if (operationId)
      return {
        ok: false,
        error: "principal session admission is draining",
        code: "DRAINING",
        operationId,
      };
    if (isRepositoryAdmissionClosed(error)) {
      return {
        ok: false,
        error: "repository admission is closed",
        code: "REPOSITORY_ADMISSION_CLOSED",
      };
    }
    if (isCreateSessionConflict(error)) {
      return {
        ok: false,
        error: "child session creation conflicted; retry the request",
        code: "CONFLICT",
      };
    }
    throw error;
  }
}

export async function listSessionChildrenDurable(
  state: ControlPlaneState,
  parentId: string,
  query: { limit: number; cursor: string | null },
): Promise<ListPage<SessionRecord>> {
  const scope = { hostId: null, repositoryId: null, kind: `session-children:${parentId}` };
  const startKey = decodeStorageCursor(query.cursor, state.sessionCursorSecret, scope);
  if (state.storage?.listSessionChildren) {
    const page = await state.storage.listSessionChildren(parentId, query.limit, startKey);
    return {
      items: page.items,
      nextCursor: encodeStorageCursor(page.nextKey ?? null, state.sessionCursorSecret, scope),
    };
  }
  const records = [...state.sessions.values()]
    .filter((session) => session.parentSessionId === parentId)
    .toSorted((left, right) => {
      const leftOrder = `${left.createdAt}#${left.id}`;
      const rightOrder = `${right.createdAt}#${right.id}`;
      return rightOrder < leftOrder ? -1 : rightOrder > leftOrder ? 1 : 0;
    });
  const cursorOrder = typeof startKey?.createdOrder === "string" ? startKey.createdOrder : null;
  const remaining = cursorOrder
    ? records.filter((session) => `${session.createdAt}#${session.id}` < cursorOrder)
    : records;
  const items = remaining.slice(0, query.limit);
  const nextOrder =
    remaining.length > query.limit && items.length > 0
      ? `${items.at(-1)!.createdAt}#${items.at(-1)!.id}`
      : null;
  return {
    items,
    nextCursor: nextOrder
      ? encodeStorageCursor(
          {
            id: items.at(-1)!.id,
            parentSessionId: parentId,
            createdOrder: nextOrder,
          },
          state.sessionCursorSecret,
          scope,
        )
      : null,
  };
}
