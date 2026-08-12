"use client";

import { useEffect, useState } from "react";

import { Input, type InputProps } from "./input.tsx";
import type { RequestFunction } from "./request-types.ts";

export type PathInputProps = InputProps & {
  /**
   * Same-origin endpoint returning `{items: string[]}` directory suggestions
   * for the current text. Host pane only — the control plane isn't running
   * on the machine whose filesystem it'd be browsing, so it never sets this
   * and gets a plain `Input` back.
   */
  browseEndpoint?: string | undefined;
  /** Request boundary; injectable for consumers that provide an in-memory transport. */
  request?: RequestFunction;
};

/** A path `Input` with optional filesystem-backed autocomplete via a `<datalist>`. */
export function PathInput({
  browseEndpoint,
  id,
  onChange,
  request = fetch,
  ...props
}: PathInputProps) {
  const [query, setQuery] = useState(String(props.defaultValue ?? props.value ?? ""));
  const [options, setOptions] = useState<string[]>([]);
  const listId = browseEndpoint ? `${id ?? "path-input"}-suggestions` : undefined;

  useEffect(() => {
    if (!browseEndpoint) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      request(`${browseEndpoint}?path=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((r) => (r.ok ? (r.json() as Promise<{ items?: string[] }>) : { items: [] }))
        .then((data) => setOptions(data.items ?? []))
        .catch(() => {
          /* suggestions are a convenience — silently give up on failure */
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [browseEndpoint, query, request]);

  return (
    <>
      <Input
        {...props}
        id={id}
        list={listId}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          onChange?.(e);
        }}
      />
      {listId ? (
        <datalist id={listId} data-pw={`${id ?? "path-input"}-suggestions`}>
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      ) : null}
    </>
  );
}
