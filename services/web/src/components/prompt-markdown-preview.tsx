import type { ReactNode } from "react";

const inlinePattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^\s)]+\))/g;

function safeHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function inlineMarkdown(value: string): ReactNode[] {
  return value.split(inlinePattern).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={index} className="rounded bg-muted px-1 font-mono text-xs">
          {part.slice(1, -1)}
        </code>
      );
    }
    const link = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(part);
    if (link) {
      const href = safeHref(link[2]!);
      return href ? (
        <a key={index} href={href} target="_blank" rel="noreferrer" className="underline">
          {link[1]}
        </a>
      ) : (
        part
      );
    }
    return part;
  });
}

export function PromptMarkdownPreview({ value }: { value: string }) {
  if (!value.trim()) {
    return <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>;
  }

  const nodes: ReactNode[] = [];
  let code: string[] | undefined;
  for (const [index, line] of value.split("\n").entries()) {
    if (line.startsWith("```")) {
      if (code) {
        nodes.push(
          <pre key={`code-${index}`} className="overflow-x-auto rounded bg-muted p-3 text-xs">
            <code>{code.join("\n")}</code>
          </pre>,
        );
        code = undefined;
      } else {
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const content = inlineMarkdown(heading[2]!);
      nodes.push(
        heading[1]?.length === 1 ? (
          <h2 key={index} className="text-lg font-semibold">
            {content}
          </h2>
        ) : heading[1]?.length === 2 ? (
          <h3 key={index} className="font-semibold">
            {content}
          </h3>
        ) : (
          <h4 key={index} className="text-sm font-semibold">
            {content}
          </h4>
        ),
      );
      continue;
    }
    const listItem = /^[-*]\s+(.+)$/.exec(line);
    if (listItem) {
      nodes.push(
        <div key={index} className="flex gap-2 pl-2">
          <span aria-hidden="true">•</span>
          <span>{inlineMarkdown(listItem[1]!)}</span>
        </div>,
      );
      continue;
    }
    if (line.startsWith("> ")) {
      nodes.push(
        <blockquote key={index} className="border-l-2 border-border pl-3 text-muted-foreground">
          {inlineMarkdown(line.slice(2))}
        </blockquote>,
      );
      continue;
    }
    nodes.push(
      line ? (
        <p key={index}>{inlineMarkdown(line)}</p>
      ) : (
        <div key={index} className="h-2" aria-hidden="true" />
      ),
    );
  }
  if (code) {
    nodes.push(
      <pre key="code-final" className="overflow-x-auto rounded bg-muted p-3 text-xs">
        <code>{code.join("\n")}</code>
      </pre>,
    );
  }

  return <div className="space-y-2 break-words text-sm">{nodes}</div>;
}
