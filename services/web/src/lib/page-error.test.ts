import { describe, expect, it } from "vitest";
import { notFound, redirect } from "next/navigation";

import { pageErrorMessage, rethrowControlFlowError } from "./page-error.ts";

/**
 * redirect()/notFound() digest shapes and isRedirectError's status-code validation are
 * internal details — capture what Next actually throws instead of hand-building a digest
 * string, so these tests exercise the real control-flow-error branch.
 */
function thrown(fn: () => never): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected fn to throw");
}

function caughtBy(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("pageErrorMessage", () => {
  it("re-throws a redirect() control-flow error instead of returning its digest", () => {
    const redirectError = thrown(() => redirect("/login"));
    expect(caughtBy(() => pageErrorMessage(redirectError))).toBe(redirectError);
  });

  it("re-throws a notFound() control-flow error instead of returning its digest", () => {
    const notFoundError = thrown(() => notFound());
    expect(caughtBy(() => pageErrorMessage(notFoundError))).toBe(notFoundError);
  });

  it("returns an ordinary Error's message", () => {
    expect(pageErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error throwable", () => {
    expect(pageErrorMessage("offline")).toBe("offline");
  });
});

describe("rethrowControlFlowError", () => {
  it("does nothing for a genuine error", () => {
    expect(caughtBy(() => rethrowControlFlowError(new Error("boom")))).toBeUndefined();
  });

  it("re-throws a redirect() control-flow error", () => {
    const redirectError = thrown(() => redirect("/login"));
    expect(caughtBy(() => rethrowControlFlowError(redirectError))).toBe(redirectError);
  });
});
