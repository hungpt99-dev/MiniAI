import type { NexioError } from '../../shared/types';
import { httpError, toProviderError, toLegacyCode, type ProviderError } from './errors/provider-error';

/**
 * Back-compat shim: request/response code lives in providers/<id>/ adapters.
 * New code imports from './providers/index', './stream', './tools-chat'.
 */
export { getAdapter, PROVIDER_ADAPTERS } from './providers/index';
export { testConnectivity } from './providers/testing';
export { resetParamCache } from './providers/retry';
export type { ChatOptions } from './stream';

/** Deprecated: use adapter.parseError instead. Kept for old callers/tests. */
export function mapHttpError(status: number, bodyText: string): NexioError {
  const e: ProviderError = httpError(status, bodyText);
  return { code: toLegacyCode(e.kind), message: e.message };
}

/** Deprecated: use toProviderError instead. Kept for old callers/tests. */
export function toNexioError(e: unknown): NexioError {
  const p = toProviderError(e);
  return { code: toLegacyCode(p.kind), message: p.message };
}
