"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Input } from "@auto-harness/ui";

/** Filterable combobox of existing `GET /hosts` hostIds. */
export function HostIdCombobox({
  id,
  name,
  dataPw,
  hostIds,
  required = false,
  defaultValue = "",
}: {
  id: string;
  name: string;
  dataPw: string;
  hostIds: string[];
  required?: boolean;
  defaultValue?: string;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [filtering, setFiltering] = useState(false);

  useEffect(() => {
    const form = rootRef.current?.closest("form");
    if (!form) return;
    const onReset = () => {
      setValue(defaultValue);
      setFiltering(false);
      setOpen(false);
      setActive(0);
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [defaultValue]);
  const matches = useMemo(() => {
    const query = value.trim().toLowerCase();
    return filtering && query
      ? hostIds.filter((hostId) => hostId.toLowerCase().includes(query))
      : hostIds;
  }, [filtering, hostIds, value]);
  const activeIndex = matches.length === 0 ? 0 : Math.min(active, matches.length - 1);
  const expanded = open && matches.length > 0;
  const trimmed = value.trim();
  const listed = trimmed === "" || hostIds.includes(trimmed);

  useEffect(() => {
    const input = rootRef.current?.querySelector("input");
    if (!input) return;
    input.setCustomValidity(listed ? "" : "Select a host from the list");
  }, [listed]);

  const select = (hostId: string) => {
    setValue(hostId);
    const index = hostIds.indexOf(hostId);
    if (index >= 0) setActive(index);
    setFiltering(false);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <Input
        id={id}
        name={name}
        role="combobox"
        required={required}
        autoComplete="off"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        {...(listed ? {} : { "aria-invalid": true as const })}
        aria-activedescendant={expanded ? `${listId}-${activeIndex}` : undefined}
        data-pw={dataPw}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setFiltering(true);
          setOpen(true);
        }}
        onFocus={() => {
          setFiltering(false);
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            return;
          }
          if (event.key === "Enter" && open && matches.length > 0) {
            event.preventDefault();
            select(matches[activeIndex]!);
            return;
          }
          if (event.key === "Enter" && !listed) {
            event.preventDefault();
            return;
          }
          if (matches.length === 0) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive((index) => (open ? (index + 1) % matches.length : 0));
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            setActive((index) => (index - 1 + matches.length) % matches.length);
            return;
          }
        }}
      />
      {expanded ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-md border border-border bg-background py-1 shadow-md"
        >
          {matches.map((hostId, index) => (
            <li
              key={hostId}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={`cursor-pointer px-3 py-1.5 text-sm ${index === activeIndex ? "bg-muted" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                select(hostId);
              }}
            >
              {hostId}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
