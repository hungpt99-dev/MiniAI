/** Strip trailing slashes so `${base}/models` never becomes `//models`. */
export function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

/** Trim + strip slashes; empty input falls back (stale/blank never wins). */
export function resolveBase(raw: string | undefined, fallback: string): string {
  const clean = stripTrailingSlash((raw || '').trim());
  return clean || fallback;
}
