import { ERROR_TECHNICAL_MAX_CHARS } from '../providers/constants';

export type ProviderErrorKind =
  | 'auth' | 'forbidden' | 'model_not_found' | 'unsupported_parameter'
  | 'context_too_long' | 'content_filtered' | 'rate_limited' | 'quota_exceeded'
  | 'overloaded' | 'bad_request' | 'network' | 'timeout' | 'aborted' | 'unknown';

export interface ProviderError {
  kind: ProviderErrorKind;
  /** Legacy code for old callers/renderer (auth, rate-limit, model, …). */
  code: LegacyCode;
  /** Friendly one-liner shown inline, with action appended where known. */
  message: string;
  /** Suggested user action key for the UI. */
  action?: 'check-key' | 'check-model' | 'shorten' | 'retry-later' | 'reset-fixes' | 'check-base-url' | 'none';
  status?: number;
  /** Redacted, truncated technical detail for the log / Details view. Never a key. */
  technical?: string;
}

/** Legacy code used by the renderer (`auth`, `rate-limit`, `model`, …). */
export type LegacyCode = 'auth' | 'rate-limit' | 'timeout' | 'network' | 'model' | 'unknown' | 'validation' | 'aborted';

export function toLegacyCode(kind: ProviderErrorKind): LegacyCode {
  switch (kind) {
    case 'auth': case 'forbidden': return 'auth';
    case 'rate_limited': case 'quota_exceeded': case 'overloaded': return 'rate-limit';
    case 'model_not_found': return 'model';
    case 'timeout': return 'timeout';
    case 'network': return 'network';
    case 'aborted': return 'aborted';
    default: return 'unknown';
  }
}

const FRIENDLY: Record<ProviderErrorKind, { text: string; action: ProviderError['action'] }> = {
  auth: { text: 'API key rejected — open Settings and check your key', action: 'check-key' },
  forbidden: { text: 'Provider refused access — check key permissions or billing', action: 'check-key' },
  model_not_found: { text: 'Model not found — check the model name or list available models', action: 'check-model' },
  unsupported_parameter: { text: 'Provider rejected a request parameter — auto-fix attempted', action: 'reset-fixes' },
  context_too_long: { text: 'Conversation too long for this model — start a new chat or shorten it', action: 'shorten' },
  content_filtered: { text: 'Provider filtered the response — rephrase and retry', action: 'none' },
  rate_limited: { text: 'Rate limited — wait a moment and retry', action: 'retry-later' },
  quota_exceeded: { text: 'Quota or billing issue — check your provider plan', action: 'retry-later' },
  overloaded: { text: 'Provider overloaded — retry shortly', action: 'retry-later' },
  bad_request: { text: 'Bad request — check model name and settings', action: 'check-model' },
  network: { text: 'Network error — check connection and base URL', action: 'check-base-url' },
  timeout: { text: 'Request timed out — retry', action: 'retry-later' },
  aborted: { text: 'Stopped', action: 'none' },
  unknown: { text: 'Request failed — see Details', action: 'none' },
};

/** Strip anything that looks like a secret before logging or display. */
export function redactSecrets(s: string): string {
  return s
    .replace(/(Bearer\s+)[^\s"'};,]+/gi, '$1…')
    .replace(/(api[_-]?key["'\s:=]+)[^"'\s;},]+/gi, '$1…')
    .replace(/(sk-[A-Za-z0-9-_]{4})[A-Za-z0-9-_]+/g, '$1…');
}

export function truncateTechnical(s: string): string {
  const clean = redactSecrets(s);
  return clean.length > ERROR_TECHNICAL_MAX_CHARS ? clean.slice(0, ERROR_TECHNICAL_MAX_CHARS) : clean;
}

export function providerError(kind: ProviderErrorKind, technical = '', status?: number): ProviderError {
  const f = FRIENDLY[kind];
  const tech = truncateTechnical(technical);
  const message = tech ? `${f.text} (${kind}): ${tech}` : `${f.text} (${kind})`;
  return { kind, code: toLegacyCode(kind), message, action: f.action, status, technical: tech || undefined };
}

/** Generic HTTP fallback when an adapter cannot parse the body. */
export function httpError(status: number, bodyText: string): ProviderError {
  if (status === 401 || status === 403) return providerError(status === 401 ? 'auth' : 'forbidden', bodyText, status);
  if (status === 404) return providerError('model_not_found', bodyText, status);
  if (status === 429) return providerError('rate_limited', bodyText, status);
  if (status >= 500) return providerError('overloaded', bodyText, status);
  if (status === 400 || status === 422) return providerError('bad_request', bodyText, status);
  return providerError('unknown', bodyText, status);
}

/** Normalize any thrown value at trust boundaries; keys never cross. */
export function toProviderError(e: unknown): ProviderError {
  if (e && typeof e === 'object' && 'kind' in e && 'message' in e) {
    const p = e as Partial<ProviderError> & { kind: ProviderErrorKind; message: string };
    if (p.code) return p as ProviderError;
    return { ...p, code: toLegacyCode(p.kind) } as ProviderError;
  }
  const err = e as Error;
  if (err?.name === 'AbortError' || /aborted/i.test(err?.message || '')) return providerError('aborted', err?.message || '');
  if (err?.name === 'TimeoutError' || /timeout/i.test(err?.message || '')) return providerError('timeout', err?.message || '');
  if (/fetch failed|network|ENOTFOUND|ECONN/i.test(err?.message || '')) return providerError('network', err?.message || '');
  return providerError('unknown', err?.message || String(e));
}
