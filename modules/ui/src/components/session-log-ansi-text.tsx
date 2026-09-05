import { ansiSpans } from "../lib/session-log-ansi.ts";
import { markSearchText } from "../lib/session-log-search.ts";

export function AnsiText({ text }: { text: string }) {
  return (
    <>
      {ansiSpans(text).map((span, index) => (
        <span
          key={index}
          className={span.bold ? "font-bold" : undefined}
          style={{ color: span.color, backgroundColor: span.background }}
        >
          {span.text}
        </span>
      ))}
    </>
  );
}

export function MarkedText({
  text,
  query,
  activeStart,
}: {
  text: string;
  query: string;
  activeStart?: number | undefined;
}) {
  return (
    <>
      {markSearchText(text, query, activeStart).map((mark, index) => {
        if (mark.kind === "plain") return <span key={index}>{mark.text}</span>;
        return (
          <mark
            key={index}
            className={
              mark.kind === "active"
                ? "rounded-sm bg-yellow-300 text-black"
                : "rounded-sm bg-yellow-300/50"
            }
          >
            {mark.text}
          </mark>
        );
      })}
    </>
  );
}
