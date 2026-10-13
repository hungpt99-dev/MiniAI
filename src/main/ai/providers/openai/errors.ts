import { httpError, providerError, type ProviderError } from '../../errors/provider-error';

function kindFrom(status: number, msg: string): ProviderError {
  const m = msg || '';
  if (status === 401 || /invalid[_-]?api[_-]?key|incorrect api key|unauthorized/i.test(m)) return providerError('auth', m, status);
  if (status === 403 || /permission|billing|account/i.test(m)) return providerError('forbidden', m, status);
  if (/model_not_found|model .* not (found|exist)|unknown model|does not exist/i.test(m)) return providerError('model_not_found', m, status);
  if (/context[_-]?length|maximum context|too many tokens|context_too_long/i.test(m)) return providerError('context_too_long', m, status);
  if (/content[_-]?filter|safety|harmful/i.test(m)) return providerError('content_filtered', m, status);
  if (/insufficient[_-]?quota|quota|billing|exceeded your|out of credits/i.test(m)) return providerError('quota_exceeded', m, status);
  if (/rate[_-]?limit|too many requests/i.test(m)) return providerError('rate_limited', m, status);
  if (/server_error|overloaded|service unavailable|try again later/i.test(m)) return providerError('overloaded', m, status);
  if (/unsupported (parameter|argument|value)|unknown (parameter|argument)|unrecognized|not supported/i.test(m)) return providerError('unsupported_parameter', m, status);
  return httpError(status, m);
}

/** OpenAI error shape: {error:{message,type,code}}. */
export function parseError(status: number, bodyText: string): ProviderError {
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: string; type?: string; code?: string } };
    const msg = [j?.error?.message, j?.error?.code, j?.error?.type].filter(Boolean).join(' ');
    if (msg) return kindFrom(status, msg);
  } catch { /* fall through to raw text */ }
  return kindFrom(status, bodyText);
}
