export type AnsiSpan = {
  text: string;
  color?: string;
  background?: string;
  bold?: boolean;
};

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ESCAPE = new RegExp(
  `${ESC}\\[([0-9;]*)([A-Za-z])|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}.`,
  "g",
);

const FG: Record<number, string> = {
  30: "#767c87",
  31: "#f87171",
  32: "#4ade80",
  33: "#facc15",
  34: "#60a5fa",
  35: "#e879f9",
  36: "#22d3ee",
  37: "#e5e7eb",
  90: "#9ca3af",
  91: "#fca5a5",
  92: "#86efac",
  93: "#fde047",
  94: "#93c5fd",
  95: "#f0abfc",
  96: "#67e8f9",
  97: "#ffffff",
};

const BG: Record<number, string> = {
  40: "#111827",
  41: "#7f1d1d",
  42: "#14532d",
  43: "#713f12",
  44: "#1e3a8a",
  45: "#701a75",
  46: "#155e75",
  47: "#e5e7eb",
};

type Style = { color?: string; background?: string; bold: boolean };

export function stripAnsi(text: string): string {
  return text.replace(ESCAPE, "");
}

export function ansiSpans(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  const style: Style = { bold: false };
  let last = 0;
  for (const match of text.matchAll(ESCAPE)) {
    const index = match.index as number;
    if (index > last) spans.push(span(text.slice(last, index), style));
    if (match[2] === "m") applySgr(match[1] || "", style);
    last = index + match[0].length;
  }
  if (last < text.length) spans.push(span(text.slice(last), style));
  return spans.filter((item) => item.text.length > 0);
}

function applySgr(params: string, style: Style): void {
  const codes = params === "" ? [0] : params.split(";").map((code) => Number(code));
  for (const code of codes) {
    if (code === 0 || Number.isNaN(code)) {
      style.color = undefined;
      style.background = undefined;
      style.bold = false;
      continue;
    }
    if (code === 1) style.bold = true;
    else if (code === 22) style.bold = false;
    else if (code === 39) style.color = undefined;
    else if (code === 49) style.background = undefined;
    else if (FG[code]) style.color = FG[code];
    else if (BG[code]) style.background = BG[code];
  }
}

function span(text: string, style: Style): AnsiSpan {
  return {
    text,
    ...(style.color ? { color: style.color } : {}),
    ...(style.background ? { background: style.background } : {}),
    ...(style.bold ? { bold: true } : {}),
  };
}
