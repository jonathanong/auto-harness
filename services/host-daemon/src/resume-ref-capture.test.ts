import { describe, expect, it } from "vitest";

import { ResumeRefCaptureReader } from "./resume-ref-capture.ts";

describe("ResumeRefCaptureReader", () => {
  it("captures the latest prefixed reference across chunks", () => {
    const reader = new ResumeRefCaptureReader({ stream: "either", linePrefix: "resume-id: " });
    expect(reader.push("stdout", "noise\nresume-id: fir")).toBe("noise\n");
    expect(reader.push("stdout", "st\n")).toBe("[CLI resume reference redacted]\n");
    expect(reader.push("stderr", "resume-id: second\n")).toBe("[CLI resume reference redacted]\n");
    expect(reader.finish()).toBe("second");
  });

  it("honors stream selection and accepts a trailing line", () => {
    const reader = new ResumeRefCaptureReader({ stream: "stderr", linePrefix: "ref=" });
    expect(reader.push("stdout", "ref=ignored\n")).toBe("ref=ignored\n");
    expect(reader.push("stderr", "ref=kept")).toBe("");
    expect(reader.finish()).toBe("kept");
    expect(reader.drainTrailing()).toEqual([
      { stream: "stderr", content: "[CLI resume reference redacted]" },
    ]);
  });

  it("preserves an unmatched trailing line from an accepted stream", () => {
    const reader = new ResumeRefCaptureReader({ stream: "stdout", linePrefix: "ref=" });
    expect(reader.push("stdout", "ordinary trailing output")).toBe("");
    expect(reader.finish()).toBeUndefined();
    expect(reader.drainTrailing()).toEqual([
      { stream: "stdout", content: "ordinary trailing output" },
    ]);
  });

  it("uses emission order for unterminated lines across streams", () => {
    const first = new ResumeRefCaptureReader({ stream: "either", linePrefix: "ref=" });
    first.push("stderr", "ref=old");
    first.push("stdout", "ref=new");
    expect(first.finish()).toBe("new");

    const second = new ResumeRefCaptureReader({ stream: "either", linePrefix: "ref=" });
    second.push("stdout", "ref=old");
    second.push("stderr", "ref=new");
    expect(second.finish()).toBe("new");

    const mixed = new ResumeRefCaptureReader({ stream: "either", linePrefix: "ref=" });
    mixed.push("stderr", "ref=old");
    mixed.push("stdout", "ref=new\n");
    expect(mixed.finish()).toBe("new");
  });

  it("rejects empty, control-character, oversized, and overlong pending values", () => {
    const reader = new ResumeRefCaptureReader({ stream: "either", linePrefix: "ref=" });
    reader.push("stdout", "ref=\nref=bad\u0000value\n");
    reader.push("stdout", `ref=${"x".repeat(513)}\n`);
    reader.push("stderr", "z".repeat(4_097));
    reader.push("stderr", "\nref=valid\n");
    expect(reader.finish()).toBe("valid");
  });

  it("drops an unterminated pending line over the bounded line limit", () => {
    const reader = new ResumeRefCaptureReader({ stream: "stdout", linePrefix: "ref=" });
    expect(reader.push("stdout", `ref=${"x".repeat(4_097)}`)).toBe(`ref=${"x".repeat(4_097)}`);
    expect(reader.push("stdout", "ref=kept\n")).toBe("[CLI resume reference redacted]\n");
    expect(reader.finish()).toBe("kept");
  });

  it("is inert without a capture policy", () => {
    const reader = new ResumeRefCaptureReader(undefined);
    expect(reader.push("stdout", "ref=ignored\n")).toBe("ref=ignored\n");
    expect(reader.finish()).toBeUndefined();
    expect(reader.drainTrailing()).toEqual([]);
  });
});
