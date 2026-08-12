/** Minimal same-origin request boundary used by inventory action components. */
export type RequestFunction = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "json" | "text">>;
