import { httpError, providerError, type ProviderError } from '../../errors/provider-error';

function kindFrom(status: number, msg: string): ProviderError {
  const m = msg || '';
  if (/authentication_error|invalid x-api-key|invalid api key|unauthorized/i.test(m)) return providerError('auth', m, status);
  if (/permission_error|forbidden/i.test(m)) return providerError('forbidden', m, status);
  if (/not_found|model .* not found|unknown model/i.test(m)) return providerError('model_not_found', m, status);
  if (/max_tokens.*required|temperature and top_p|must be .* (user|assistant)|system.*role|invalid_request/i.test(m)
    && /param|field|role|system|temperature|top_p|max_tokens/i.test(m)) {
    return /max_tokens.*required/i.test(m) && status !== 400
      ? httpError(status, m)
      : providerError(/unsupported|not supported|temperature and/i.test(m) ? 'unsupported_parameter' : 'bad_request', m, status);
  }
  if (/rate_limit/i.test(m)) return providerError('rate_limited', m, status);
  if (/overloaded/i.test(m)) return providerError('overloaded', m, status);
  if (/context|too many tokens|prompt is too long/i.test(m)) return providerError('context_too_long', m, status);
  return httpError(status, m);
}

/** Anthropic error shape: {error:{type,message}}. */
export function parseError(status: number, bodyText: string): ProviderError {
  try {
    const j = JSON.parse(bodyText) as { error?: { type?: string; message?: string } };
    const msg = [j?.error?.type, j?.error?.message].filter(Boolean).join(' ');
    if (msg) return kindFrom(status, msg);
  } catch { /* fall through */ }
  return kindFrom(status, bodyText);
}
