import { httpError, providerError, type ProviderError } from '../../errors/provider-error';

function kindFrom(status: number, msg: string): ProviderError {
  const m = msg || '';
  if (/API_KEY_INVALID|API key not valid|invalid.*api.*key|unauthorized|UNAUTHENTICATED/i.test(m)) return providerError('auth', m, status);
  if (/PERMISSION_DENIED|forbidden/i.test(m)) return providerError('forbidden', m, status);
  if (/NOT_FOUND|model .* not found|unknown model/i.test(m)) return providerError('model_not_found', m, status);
  if (/RESOURCE_EXHAUSTED/i.test(m)) return /quota|billing|limit.*project/i.test(m)
    ? providerError('quota_exceeded', m, status) : providerError('rate_limited', m, status);
  if (/UNAVAILABLE|overloaded|try again later/i.test(m)) return providerError('overloaded', m, status);
  if (/unsupported|unknown (parameter|field)|not supported/i.test(m)) return providerError('unsupported_parameter', m, status);
  if (/context|too many tokens|prompt.*too (long|large)|RESOURCE_EXHAUSTED/i.test(m) && /token|context|prompt/i.test(m)) {
    return status === 400 ? providerError('context_too_long', m, status) : providerError('rate_limited', m, status);
  }
  if (/safety|blocked.*harm|content.*filter/i.test(m)) return providerError('content_filtered', m, status);
  return httpError(status, m);
}

/** Native shape {error:{message,code,status}} or OpenAI-compat {error:{message,type,code}}. */
export function parseError(status: number, bodyText: string): ProviderError {
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: string; type?: string; code?: string | number; status?: string } };
    const msg = [j?.error?.status, j?.error?.message, j?.error?.code, j?.error?.type].filter((x) => x !== undefined).join(' ');
    if (msg.trim()) return kindFrom(status, msg);
  } catch { /* fall through */ }
  return kindFrom(status, bodyText);
}
