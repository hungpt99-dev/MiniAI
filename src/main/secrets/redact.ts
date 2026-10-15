/** Redact anything that looks like an API key / bearer token. Safe to log the result. */
export function redact(text: string): string {
  return String(text)
    .replace(/(sk-[A-Za-z0-9-_]{4})[A-Za-z0-9-_]+/g, '$1***')
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/-]+=*)(?=[\s'"]|$)/gi, '$1***')
    .replace(/(api[_-]?key["'\s:=]+)([A-Za-z0-9._-]+)/gi, '$1***');
}
