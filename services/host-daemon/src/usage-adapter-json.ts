export function jsonObjects(output: string): unknown[] {
  const objects: unknown[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      objects.push(JSON.parse(trimmed) as unknown);
    } catch {
      // Streamed CLIs mix JSON with banners; skip undecodable lines.
    }
  }
  const trimmed = output.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      objects.push(JSON.parse(trimmed) as unknown);
    } catch {
      // Fall through to brace matching for concatenated JSON objects.
    }
  }
  objects.push(...embeddedJsonObjects(output));
  return objects;
}

function embeddedJsonObjects(output: string): unknown[] {
  const objects: unknown[] = [];
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== "{") continue;
    const end = matchingBrace(output, index);
    if (end < 0) continue;
    try {
      objects.push(JSON.parse(output.slice(index, end + 1)) as unknown);
    } catch {
      continue;
    }
    index = end;
  }
  return objects;
}

function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}
