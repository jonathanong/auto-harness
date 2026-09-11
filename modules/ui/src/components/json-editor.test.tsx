// @vitest-environment happy-dom

import { forceLinting } from "@codemirror/lint";
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "codemirror";

import { mount, reset } from "./action-form-test-helpers.ts";
import { JsonEditor } from "./json-editor.tsx";

afterEach(reset);

function editorView(container: HTMLElement): EditorView {
  const element = container.querySelector(".cm-editor");
  if (!(element instanceof HTMLElement)) throw new Error("missing CodeMirror editor");
  const view = EditorView.findFromDOM(element);
  if (!view) throw new Error("missing CodeMirror view");
  return view;
}

function ValueHarness({
  initial,
  validate,
}: {
  initial: string;
  validate?: (value: unknown) => string | null | undefined;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <button type="button" data-pw="replace-json" onClick={() => setValue('{"replaced":true}')}>
        Replace
      </button>
      <label id="json-label" htmlFor="json-editor">
        Inventory
      </label>
      <JsonEditor
        value={value}
        onChange={setValue}
        validate={validate}
        labelledBy="json-label"
        pw="json-editor"
      />
    </>
  );
}

describe("JsonEditor", () => {
  it("lints schema errors and doc edits, then syncs an external value", () => {
    const view = mount(
      <ValueHarness
        initial="{}"
        validate={(value) => ((value as { ok?: boolean }).ok ? null : "must be ok")}
      />,
    );

    expect(view.container.querySelector('[data-pw="json-editor-validation"]')?.textContent).toBe(
      "must be ok",
    );

    act(() => {
      forceLinting(editorView(view.container));
    });

    act(() => {
      const cm = editorView(view.container);
      cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: '{"ok":true}' } });
      forceLinting(cm);
    });
    expect(view.container.querySelector('[data-pw="json-editor-validation"]')?.textContent).toBe(
      "Valid host inventory JSON",
    );

    act(() => {
      const cm = editorView(view.container);
      cm.dispatch({ selection: { anchor: 0 } });
      cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: "{not json" } });
      forceLinting(cm);
    });
    expect(
      view.container.querySelector('[data-pw="json-editor-validation"]')?.textContent,
    ).toContain("JSON");

    act(() => {
      view.container
        .querySelector('[data-pw="replace-json"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(editorView(view.container).state.doc.toString()).toBe('{"replaced":true}');
    view.unmount();
  });

  it("reports a non-Error JSON parse failure", () => {
    const parse = vi.spyOn(JSON, "parse").mockImplementation(() => {
      throw "nope";
    });
    const view = mount(
      <JsonEditor value="{}" onChange={() => {}} labelledBy="json-label" pw="json-editor" />,
    );
    expect(view.container.querySelector('[data-pw="json-editor-validation"]')?.textContent).toBe(
      "Invalid JSON",
    );
    parse.mockRestore();
    view.unmount();
  });
});
