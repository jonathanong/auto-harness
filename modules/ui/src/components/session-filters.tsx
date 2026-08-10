"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";

import { Input } from "./input.tsx";
import { Label } from "./label.tsx";

const STATUSES = ["all", "queued", "running", "completed", "failed", "cancelled", "timed_out"];

export type SessionFiltersProps = {
  /** List page these filters live on. Default "/sessions". */
  basePath?: string;
};

function buildHref(basePath: string, status: string, q: string, concurrencyId: string): string {
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
  const s = p.toString();
  return s ? `${basePath}?${s}` : basePath;
}

/** URL-backed status/search filters — shared by control plane and host pane session lists. */
export function SessionFilters({ basePath = "/sessions" }: SessionFiltersProps) {
  const router = useRouter();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const status = sp.get("status") ?? "all";
  const q = sp.get("q") ?? "";
  const concurrencyId = sp.get("concurrencyId") ?? "";

  const push = useCallback(
    (next: { status?: string; q?: string; concurrencyId?: string }) => {
      start(() => {
        router.push(
          buildHref(
            basePath,
            next.status ?? status,
            next.q ?? q,
            next.concurrencyId ?? concurrencyId,
          ),
        );
      });
    },
    [router, basePath, status, q, concurrencyId],
  );

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
      <div className="min-w-[12rem] flex-1 space-y-1">
        <Label htmlFor="q" tip="Substring match on session id, prompt, or concurrency ID">
          Search
        </Label>
        <Input
          id="q"
          data-pw="session-filter-q"
          defaultValue={q}
          placeholder="session id, prompt, or concurrency ID…"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              push({ q: (e.target as HTMLInputElement).value });
            }
          }}
          onBlur={(e) => {
            if (e.target.value !== q) {
              push({ q: e.target.value });
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
          defaultValue={concurrencyId}
          placeholder="exact concurrency ID…"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              push({ concurrencyId: (e.target as HTMLInputElement).value });
            }
          }}
          onBlur={(e) => {
            if (e.target.value !== concurrencyId) {
              push({ concurrencyId: e.target.value });
            }
          }}
        />
      </div>
    </div>
  );
}
