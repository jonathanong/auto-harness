"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";

import { Input } from "./input.tsx";
import { Label } from "./label.tsx";

const STATUSES = ["all", "queued", "running", "completed", "failed", "cancelled", "timed_out"];
const SORTS = [
  ["latest", "Latest"],
  ["oldest", "Oldest"],
  ["priority_desc", "Priority (high → low)"],
  ["priority_asc", "Priority (low → high)"],
] as const;

export type SessionFiltersProps = {
  /** List page these filters live on. Default "/sessions". */
  basePath?: string;
};

function buildHref(
  basePath: string,
  status: string,
  q: string,
  concurrencyId: string,
  sort: string,
): string {
  const p = new URLSearchParams();
  if (status && status !== "all") {
    p.set("status", status);
  }
  if (q) {
    p.set("q", q);
  }
  if (concurrencyId) {
    p.set("concurrencyId", concurrencyId);
  }
  if (sort && sort !== "latest") {
    p.set("sort", sort);
  }
  const s = p.toString();
  return s ? `${basePath}?${s}` : basePath;
}

/** URL-backed status/search/sort filters — shared by control plane and host pane session lists. */
export function SessionFilters({ basePath = "/sessions" }: SessionFiltersProps) {
  const router = useRouter();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const status = sp.get("status") ?? "all";
  const q = sp.get("q") ?? "";
  const concurrencyId = sp.get("concurrencyId") ?? "";
  const sort = sp.get("sort") ?? "latest";
  const [queryDraft, setQueryDraft] = useState(q);
  const [concurrencyDraft, setConcurrencyDraft] = useState(concurrencyId);

  useEffect(() => {
    setQueryDraft(q);
    setConcurrencyDraft(concurrencyId);
  }, [concurrencyId, q]);

  const push = useCallback(
    (next: { status?: string; q?: string; concurrencyId?: string; sort?: string }) => {
      start(() => {
        router.push(
          buildHref(
            basePath,
            next.status ?? status,
            next.q ?? q,
            next.concurrencyId ?? concurrencyId,
            next.sort ?? sort,
          ),
        );
      });
    },
    [router, basePath, status, q, concurrencyId, sort],
  );

  useEffect(() => {
    if (queryDraft === q) return;
    const timer = setTimeout(() => push({ q: queryDraft }), 300);
    return () => clearTimeout(timer);
  }, [push, q, queryDraft]);

  return (
    <div
      className={`flex flex-wrap items-end gap-3 ${pending ? "opacity-70" : ""}`}
      data-pw="session-filters"
    >
      <div className="space-y-1">
        <Label htmlFor="status" tip="Filter sessions by lifecycle status">
          Status
        </Label>
        <select
          id="status"
          data-pw="session-filter-status"
          className="flex h-9 rounded-md border border-border bg-background px-3 text-sm"
          value={status}
          onChange={(e) => {
            push({ status: e.target.value });
          }}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="sort" tip="Sort the current session list">
          Sort
        </Label>
        <select
          id="sort"
          data-pw="session-filter-sort"
          className="flex h-9 rounded-md border border-border bg-background px-3 text-sm"
          value={sort}
          onChange={(e) => {
            push({ sort: e.target.value });
          }}
        >
          {SORTS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="min-w-[12rem] flex-1 space-y-1">
        <Label htmlFor="q" tip="Substring match across fields on the loaded sessions">
          Search
        </Label>
        <Input
          id="q"
          data-pw="session-filter-q"
          value={queryDraft}
          placeholder="session fields…"
          onChange={(e) => setQueryDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              push({ q: queryDraft });
            }
          }}
          onBlur={() => {
            if (queryDraft !== q) {
              push({ q: queryDraft });
            }
          }}
        />
      </div>
      <div className="min-w-[12rem] space-y-1">
        <Label htmlFor="concurrencyId" tip="Exact match on the session concurrency ID">
          Concurrency ID
        </Label>
        <Input
          id="concurrencyId"
          data-pw="session-filter-concurrency-id"
          value={concurrencyDraft}
          placeholder="exact concurrency ID…"
          onChange={(e) => {
            setConcurrencyDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              push({ concurrencyId: concurrencyDraft });
            }
          }}
          onBlur={() => {
            if (concurrencyDraft !== concurrencyId) {
              push({ concurrencyId: concurrencyDraft });
            }
          }}
        />
      </div>
    </div>
  );
}
