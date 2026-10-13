import { httpError, providerError, type ProviderError } from '../../errors/provider-error';

function kindFrom(status: number, msg: string): ProviderError {
  const m = msg || '';
  if (status === 401 || /invalid.*api.*key|unauthorized|no auth|missing.*key/i.test(m)) return providerError('auth', m, status);
  if (status === 403) return providerError('forbidden', m, status);
  if (/model.*not found|unknown model|does not exist|model_list|not a valid model/i.test(m)) return providerError('model_not_found', m, status);
  if (/context|too many tokens|maximum context/i.test(m)) return providerError('context_too_long', m, status);
  if (/quota|billing|credits/i.test(m)) return providerError('quota_exceeded', m, status);
  if (/rate.?limit|too many requests|429/i.test(m)) return providerError('rate_limited', m, status);
  if (/unsupported|unknown (parameter|argument|field)|unrecognized|not supported|additional properties/i.test(m)) {
    return providerError('unsupported_parameter', m, status);
  }
  if (/connection refused|ECONNREFUSED|failed to connect|not running/i.test(m)) return providerError('network', m, status);
  return httpError(status, m);
}

/** OpenAI-shaped error {error:{message,type,code}} or plain text (local servers). */
export function parseError(status: number, bodyText: string): ProviderError {
  try {
    const j = JSON.parse(bodyText) as { error?: string | { message?: string; type?: string; code?: string } };
    const msg = typeof j?.error === 'string' ? j.error
      : [j?.error?.message, j?.error?.code, j?.error?.type].filter(Boolean).join(' ');
    if (msg) return kindFrom(status, msg);
  } catch { /* plain text below */ }
  return kindFrom(status, bodyText);
}
