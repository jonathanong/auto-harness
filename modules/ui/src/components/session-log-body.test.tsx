// @vitest-environment happy-dom

import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { SessionLogRecord } from "../lib/session-log-records.ts";
import { field, mount, reset } from "./action-form-test-helpers.ts";
import { AnsiText, MarkedText } from "./session-log-ansi-text.tsx";
import { SessionLogBody } from "./session-log-body.tsx";
import { SessionLogViewer } from "./session-log-viewer.tsx";

afterEach(reset);

const output: SessionLogRecord = {
  line: 1,
  raw: "\u001b[1mhi",
  category: "output",
  typeLabel: "output",
  preview: "\u001b[1mhi",
  json: undefined,
};

const jsonRecord: SessionLogRecord = {
  line: 2,
  raw: '{"a":1}',
  category: "other",
  typeLabel: "json",
  preview: "json",
  json: { a: 1 },
};

describe("session log body", () => {
  it("renders ANSI, pretty JSON, collapsed JSON, and search marks", () => {
    const ansi = mount(
      <div data-pw="ansi">
        <AnsiText text={"\u001b[1mhi"} />
      </div>,
    );
    expect(field(ansi.container, "ansi").innerHTML).toContain("font-bold");
    const marks = mount(
      <div data-pw="marks">
        <MarkedText text="abXab" query="ab" activeStart={3} />
      </div>,
    );
    expect(marks.container.querySelectorAll("mark")).toHaveLength(2);
    const searched = mount(
      <div data-pw="body">
        <SessionLogBody record={output} pretty={false} query="hi" collapsed={false} />
      </div>,
    );
    expect(field(searched.container, "body").textContent).toBe("hi");
    const pretty = mount(
      <div data-pw="pretty">
        <SessionLogBody record={jsonRecord} pretty={true} query="" collapsed={false} />
      </div>,
    );
    expect(field(pretty.container, "pretty").textContent).toContain('"a": 1');
    const collapsed = mount(
      <div data-pw="collapsed">
        <SessionLogBody
          record={{
            ...jsonRecord,
            json: { a: "z".repeat(600) },
            preview: "z".repeat(600),
          }}
          pretty={true}
          query=""
          collapsed={true}
        />
      </div>,
    );
    expect(field(collapsed.container, "collapsed").textContent?.length).toBe(500);
    const empty = mount(
      <SessionLogViewer
        records={[]}
        pretty={true}
        fontSize={13}
        query=""
        expanded={new Set()}
        fullscreen={false}
        scrollerRef={createRef<HTMLDivElement>()}
        onLineClick={() => undefined}
        onToggleExpand={() => undefined}
      />,
    );
    expect(field(empty.container, "session-logs")).toBeTruthy();
  });
});
