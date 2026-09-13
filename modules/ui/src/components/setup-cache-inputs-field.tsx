"use client";

import type { ChangeEventHandler } from "react";

import { Label } from "./label.tsx";
import { Textarea } from "./textarea.tsx";

export const SETUP_CACHE_INPUTS_TIP =
  "Relative checkout paths whose contents must stay unchanged to reuse the last successful setup. One path per line. The host never auto-detects lockfiles or manifests.";

export function SetupCacheInputsField({
  id,
  name = "setupCacheInputs",
  dataPw,
  value,
  defaultValue,
  onChange,
}: {
  id: string;
  name?: string;
  dataPw: string;
  value?: string;
  defaultValue?: string;
  onChange?: ChangeEventHandler<HTMLTextAreaElement>;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} tip={SETUP_CACHE_INPUTS_TIP}>
        Setup Cache Inputs
      </Label>
      <Textarea
        id={id}
        name={name}
        rows={3}
        className="font-mono text-xs"
        data-pw={dataPw}
        {...(value !== undefined ? { value } : { defaultValue: defaultValue ?? "" })}
        {...(onChange ? { onChange } : {})}
      />
    </div>
  );
}
