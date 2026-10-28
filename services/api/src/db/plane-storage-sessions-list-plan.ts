import { SESSION_STATUSES, type SessionStatus } from "@auto-harness/shared";

import {
  SESSION_LIST_PARTITION_VALUE,
  SESSIONS_CREATED_ORDER_INDEX,
  SESSIONS_LIST_CREATED_ORDER_INDEX,
  SESSIONS_PRIORITY_ORDER_INDEX,
  SESSIONS_REPOSITORY_CREATED_ORDER_INDEX,
  SESSIONS_REPOSITORY_PRIORITY_ORDER_INDEX,
  SESSIONS_ROUTE_WORKTREE_CREATED_ORDER_INDEX,
  repositoryPriorityOrderRange,
} from "../control-plane-ordering.ts";
import { statusShardAttr } from "./dynamo.ts";
import type { SessionListPageQuery } from "./plane-storage-sessions-list-page.ts";
import type { Partition } from "./plane-storage-sessions-list-window.ts";

/**
 * The one-partition plan for a created-order list, or undefined when only the status/shard
 * plan can answer it. A worktree wins over a repository, which wins over the global index;
 * every other filter is applied to the rows read. Status, host, source, concurrency, schedule
 * and repository-scope filters keep the status partitions when nothing narrower applies.
 */
export function singlePartition(query: SessionListPageQuery): Partition | undefined {
  if (query.sort.startsWith("priority_")) return undefined;
  const forward = query.sort === "oldest";
  if (query.worktreeId) {
    return singleIndex(
      SESSIONS_ROUTE_WORKTREE_CREATED_ORDER_INDEX,
      "routeWorktreeId",
      query.worktreeId,
      forward,
    );
  }
  if (query.repositoryId) {
    return singleIndex(
      SESSIONS_REPOSITORY_CREATED_ORDER_INDEX,
      "repositoryId",
      query.repositoryId,
      forward,
    );
  }
  if (
    query.status === null &&
    query.hostId === null &&
    query.source === null &&
    query.concurrencyId === null &&
    query.scheduleId === null &&
    query.repositoryIds === null
  ) {
    return singleIndex(
      SESSIONS_LIST_CREATED_ORDER_INDEX,
      "sessionList",
      SESSION_LIST_PARTITION_VALUE,
      forward,
    );
  }
  return undefined;
}

function singleIndex(
  indexName: string,
  keyName: "repositoryId" | "routeWorktreeId" | "sessionList",
  keyValue: string,
  forward: boolean,
): Partition {
  return {
    id: `${keyName}:${keyValue}`,
    indexName,
    keyName,
    keyValue,
    forward,
    sortKeyName: "createdOrder",
  };
}

/** The status x queue-shard fan-out that predates the one-partition indexes. */
export function legacyPartitionPlan(query: SessionListPageQuery): Partition[] {
  if (query.repositoryIds?.length === 0) return [];
  const statusPartitions = statuses(query).flatMap((status) =>
    [...Array(query.shardCount).keys()].map((shard) => statusPartition(query, status, shard)),
  );
  if (query.repositoryId) {
    if (query.repositoryIds && !query.repositoryIds.includes(query.repositoryId)) return [];
    return query.sort.startsWith("priority_")
      ? repositoryPriorityPartitions(query, [query.repositoryId])
      : statusPartitions;
  }
  // A large scope must not turn into one cursor checkpoint per repository.
  // Scope filtering happens after the fixed status/shard index reads instead.
  return statusPartitions;
}

function repositoryPriorityPartitions(
  query: SessionListPageQuery,
  repositoryIds: readonly string[],
): Partition[] {
  return statuses(query).flatMap((status) =>
    [...Array(query.shardCount).keys()].flatMap((shard) =>
      repositoryIds.map((repositoryId) => {
        const range = repositoryPriorityOrderRange(repositoryId);
        return {
          id: `repository-priority:${repositoryId}:${status}:${shard}`,
          indexName: SESSIONS_REPOSITORY_PRIORITY_ORDER_INDEX,
          keyName: "statusShard" as const,
          keyValue: statusShardAttr(status, shard),
          forward: query.sort === "priority_asc",
          sortKeyName: "repositoryPriorityOrder" as const,
          sortKeyRange: range,
          repositoryId,
        };
      }),
    ),
  );
}

function statusPartition(
  query: SessionListPageQuery,
  status: SessionStatus,
  shard: number,
): Partition {
  const priority = query.sort.startsWith("priority_");
  return {
    id: `status:${status}:${shard}`,
    indexName: priority ? SESSIONS_PRIORITY_ORDER_INDEX : SESSIONS_CREATED_ORDER_INDEX,
    keyName: "statusShard",
    keyValue: statusShardAttr(status, shard),
    forward: priority ? query.sort === "priority_asc" : query.sort !== "latest",
    sortKeyName: priority ? "priorityOrder" : "createdOrder",
  };
}

function statuses(query: SessionListPageQuery): readonly SessionStatus[] {
  return query.status ? [query.status] : SESSION_STATUSES;
}
