"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";
import { Input, Label } from "@auto-harness/ui";

import { sessionListHref } from "../lib/url-state.ts";

const STATUSES = ["all", "queued", "running", "completed", "failed", "cancelled", "timed_out"];

/** URL-backed filters — client navigation, no full document reload. */
export function SessionFilters() {
  const router = useRouter();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const status = sp.get("status") ?? "all";
  const q = sp.get("q") ?? "";

  const push = useCallback(
    (next: { status?: string; q?: string }) => {
      start(() => {
        router.push(
          sessionListHref({
            status: next.status ?? status,
            q: next.q ?? q,
          }),
        );
      });
    },
    [router, status, q],
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
        <Label htmlFor="q" tip="Substring match on session id or prompt (Enter or blur to apply)">
          Search
        </Label>
        <Input
          id="q"
          data-pw="session-filter-q"
          defaultValue={q}
          placeholder="session id or prompt…"
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
    </div>
  );
}
