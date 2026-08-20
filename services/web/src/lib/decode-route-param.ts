/** Next may pass dynamic route params still percent-encoded (e.g. `admin%3Aadmin`). */
export function decodeRouteParam(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
