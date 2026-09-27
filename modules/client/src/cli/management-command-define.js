const LIMIT = { flag: "--limit", name: "limit" };
const CURSOR = { flag: "--cursor", name: "cursor" };

export const IF_MATCH = [
  { flag: "--if-match", header: "If-Match", required: true },
  { flag: "--if-match-generation", header: "If-Match-Generation", required: true },
];

export const IDEMPOTENCY = [{ flag: "--idempotency-key", header: "Idempotency-Key" }];

export function q(flag, name, required = false) {
  return required ? { flag, name, required: true } : { flag, name };
}

export function paged(query = []) {
  return { paging: true, query: [...query, LIMIT, CURSOR] };
}

export function cmd(argv, method, path, extra = {}) {
  const methods = Array.isArray(method) ? method : [method];
  return {
    id: extra.id ?? argv.join("."),
    argv,
    methods,
    defaultMethod: extra.defaultMethod ?? (methods.includes("PATCH") ? "PATCH" : methods[0]),
    path,
    params: extra.params ?? [],
    query: extra.query ?? [],
    paging: extra.paging ?? false,
    body: extra.body ?? "none",
    headers: extra.headers ?? [],
  };
}
