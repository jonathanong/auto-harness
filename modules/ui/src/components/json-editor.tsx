"use client";

import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { basicSetup, EditorView } from "codemirror";
import { useEffect, useRef, useState } from "react";

export type JsonValueValidator = (value: unknown) => string | null | undefined;

export type JsonEditorProps = {
  value: string;
  onChange: (value: string) => void;
  validate?: JsonValueValidator | undefined;
  onValidationChange?: ((error: string | null) => void) | undefined;
  labelledBy: string;
  pw?: string | undefined;
};

function validationError(raw: string, validate?: JsonValueValidator): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid JSON";
  }
  return validate?.(parsed) ?? null;
}

export function JsonEditor({
  value,
  onChange,
  validate,
  onValidationChange,
  labelledBy,
  pw = "json-editor",
}: JsonEditorProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const changeRef = useRef(onChange);
  const validateRef = useRef(validate);
  const validationChangeRef = useRef(onValidationChange);
  const [error, setError] = useState(() => validationError(value, validate));
  changeRef.current = onChange;
  validateRef.current = validate;
  validationChangeRef.current = onValidationChange;

  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;

    const reportValidation = (raw: string) => {
      const nextError = validationError(raw, validateRef.current);
      setError(nextError);
      validationChangeRef.current?.(nextError);
    };
    const schemaLinter = linter((view): Diagnostic[] => {
      const raw = view.state.doc.toString();
      try {
        const parsed = JSON.parse(raw) as unknown;
        const message = validateRef.current?.(parsed);
        return message
          ? [
              {
                from: 0,
                to: Math.min(1, raw.length),
                severity: "error",
                message,
              },
            ]
          : [];
      } catch {
        return [];
      }
    });
    const theme = EditorView.theme({
      "&": {
        border: "1px solid hsl(var(--border))",
        borderRadius: "var(--radius)",
        backgroundColor: "hsl(var(--background))",
        color: "hsl(var(--foreground))",
        fontSize: "0.75rem",
      },
      ".cm-content": {
        caretColor: "hsl(var(--foreground))",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
        minHeight: "24rem",
      },
      ".cm-gutters": {
        backgroundColor: "hsl(var(--muted))",
        borderRight: "1px solid hsl(var(--border))",
        color: "hsl(var(--muted-foreground))",
      },
      ".cm-activeLine, .cm-activeLineGutter": {
        backgroundColor: "hsl(var(--muted) / 0.65)",
      },
      "&.cm-focused": {
        outline: "2px solid hsl(var(--ring))",
        outlineOffset: "2px",
      },
    });
    const view = new EditorView({
      parent,
      doc: value,
      extensions: [
        basicSetup,
        json(),
        lintGutter(),
        linter(jsonParseLinter()),
        schemaLinter,
        EditorView.lineWrapping,
        theme,
        EditorView.contentAttributes.of({
          "aria-labelledby": labelledBy,
          "aria-multiline": "true",
          role: "textbox",
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const raw = update.state.doc.toString();
          changeRef.current(raw);
          reportValidation(raw);
        }),
      ],
    });
    viewRef.current = view;
    reportValidation(value);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [labelledBy]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  return (
    <div className="space-y-2">
      <div ref={parentRef} data-pw={pw} />
      <p
        className={error ? "text-sm text-destructive" : "text-sm text-emerald-700"}
        role={error ? "alert" : "status"}
        aria-live="polite"
        data-pw={`${pw}-validation`}
      >
        {error ?? "Valid host inventory JSON"}
      </p>
    </div>
  );
}
