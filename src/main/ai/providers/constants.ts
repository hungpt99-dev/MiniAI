/** Shared provider constants — no magic numbers in adapters. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
export const TEST_MAX_OUTPUT_TOKENS = 16;
export const TEST_TIMEOUT_MS = 15_000;
export const CHAT_TIMEOUT_MS = 60_000;
export const RETRY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const RETRY_MAX_ATTEMPTS_NON_STREAMING = 2;
export const ERROR_TECHNICAL_MAX_CHARS = 500;
