const PATTERNS: RegExp[] = [
  /usage[_\s-]?limit/i,
  /rate[_\s-]?limit/i,
  /quota[_\s-]?exceeded/i,
  /insufficient_quota/i,
  /you exceeded your current quota/i,
  /rate limit reached/i,
  /rate_limit_error/i,
  /monthly limit/i,
  /too many requests/i,
];

/** Parse CLI output for vendor usage/rate limit signals (parse → fail). */
export function detectUsageLimit(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  return PATTERNS.some((re) => re.test(text));
}
