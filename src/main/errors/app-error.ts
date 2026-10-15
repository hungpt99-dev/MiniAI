import { redact } from '../secrets/redact';

/** Stable error codes for user-facing failures. The main message shown in the
 * UI is always `friendly` (never a raw Electron/Node string); `technical`
 * carries the redacted detail behind the Details toggle. */
export type AppErrorCode =
  | 'SECRET_UNREADABLE'
  | 'SECRET_UNAVAILABLE'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_RATE_LIMIT'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'MODE_READ_ONLY'
  | 'VALIDATION'
  | 'UNKNOWN';

export type AppErrorAction = 'open-settings' | 'retry' | null;

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly friendly: string;
  readonly technical: string;
  readonly action: AppErrorAction;
  constructor(code: AppErrorCode, friendly: string, technical = '', action: AppErrorAction = null) {
    super(`${code}: ${friendly}`);
    this.name = 'AppError';
    this.code = code;
    this.friendly = friendly;
    this.technical = technical;
    this.action = action;
  }
}

const FRIENDLY: Record<AppErrorCode, { text: string; action: AppErrorAction }> = {
  SECRET_UNREADABLE: {
    text: 'Nexio could not unlock your saved API key. Enter it again in Settings.',
    action: 'open-settings',
  },
  SECRET_UNAVAILABLE: {
    text: 'Secure storage is not available on this system. The key was kept for this session only.',
    action: 'open-settings',
  },
  PROVIDER_NOT_CONFIGURED: {
    text: 'No API key is set for this provider. Enter it in Settings to continue.',
    action: 'open-settings',
  },
  PROVIDER_AUTH: {
    text: 'The provider rejected the API key. Check it in Settings and try again.',
    action: 'open-settings',
  },
  PROVIDER_RATE_LIMIT: { text: 'The provider is rate-limiting requests. Wait a bit and retry.', action: 'retry' },
  NETWORK: { text: 'Could not reach the provider. Check your network and base URL.', action: 'retry' },
  TIMEOUT: { text: 'The provider took too long to respond.', action: 'retry' },
  ABORTED: { text: 'Stopped.', action: null },
  MODE_READ_ONLY: { text: 'Blocked: Ask mode is read-only. Switch to Do mode (Tab) to act.', action: null },
  VALIDATION: { text: 'That request was invalid.', action: null },
  UNKNOWN: { text: 'Something went wrong.', action: null },
};

export function friendlyFor(code: AppErrorCode): { text: string; action: AppErrorAction } {
  return FRIENDLY[code];
}

/** Classify any thrown value. Never throws; technical text is redacted so it
 * is safe to show behind Details (never secrets, ciphertext or key material). */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  // why: technical detail carries neither secrets nor paths, only shapes.
  const tech = (m: string): string => redactPaths(redact(m)).slice(0, 500);
  const code = (e as { code?: unknown })?.code;
  if (typeof code === 'string') {
    if (code === 'aborted') return new AppError('ABORTED', FRIENDLY.ABORTED.text, tech(msg));
    if (code === 'rate-limit' || code === 'RATE_LIMIT') {
      return new AppError('PROVIDER_RATE_LIMIT', FRIENDLY.PROVIDER_RATE_LIMIT.text, tech(msg), 'retry');
    }
    if (code === 'IPC_VALIDATION') return new AppError('VALIDATION', FRIENDLY.VALIDATION.text, tech(msg));
  }
  if (/decrypt|os_crypt|safe.?storage|keychain|dpapi/i.test(msg)) {
    return new AppError('SECRET_UNREADABLE', FRIENDLY.SECRET_UNREADABLE.text, tech(msg), 'open-settings');
  }
  if (/no decryption backend|secure storage/i.test(msg)) {
    return new AppError('SECRET_UNAVAILABLE', FRIENDLY.SECRET_UNAVAILABLE.text, tech(msg), 'open-settings');
  }
  if (/401|unauthorized|invalid api key|invalid_api_key|authentication/i.test(msg)) {
    return new AppError('PROVIDER_AUTH', FRIENDLY.PROVIDER_AUTH.text, tech(msg), 'open-settings');
  }
  if (/429|rate.?limit|retry-after/i.test(msg)) {
    return new AppError('PROVIDER_RATE_LIMIT', FRIENDLY.PROVIDER_RATE_LIMIT.text, tech(msg), 'retry');
  }
  if (/vision-not-supported/i.test(msg)) {
    // Attachment notice is rendered by its own path; keep it reachable.
    return new AppError('VALIDATION', msg.slice(0, 200), tech(msg));
  }
  if (/MODE_READ_ONLY/.test(msg)) return new AppError('MODE_READ_ONLY', FRIENDLY.MODE_READ_ONLY.text, tech(msg));
  if (/timeout|timed out|ETIMEDOUT|aborted/i.test(msg) && !/user/i.test(msg)) {
    if (/stop/i.test(msg)) return new AppError('ABORTED', FRIENDLY.ABORTED.text, tech(msg));
    return new AppError('TIMEOUT', FRIENDLY.TIMEOUT.text, tech(msg), 'retry');
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|fetch failed|network|socket|TLS|SSL|certificate|proxy/i.test(msg)) {
    return new AppError('NETWORK', FRIENDLY.NETWORK.text, tech(msg), 'retry');
  }
  // Default: domain errors already carry user-facing text — keep it (redacted,
  // truncated), mapping only the raw patterns above. Empty -> generic.
  const kept = redact(msg).slice(0, 500).trim();
  if (!kept) return new AppError('UNKNOWN', FRIENDLY.UNKNOWN.text, '');
  return new AppError('UNKNOWN', kept, tech(msg));
}

/** Redact filesystem paths for technical detail (drive + posix absolutes). */
export function redactPaths(text: string): string {
  return String(text)
    .replace(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g, '<path>')
    .replace(/(^|[\s"'`])\/(?:[^/\s"'`]+\/)*[^/\s"'`]*/g, '$1<path>');
}

/** A run needs a stored provider key: missing -> not configured, present but
 * unreadable -> SECRET_UNREADABLE. Throws AppError (friendly by construction). */
export function missingKeyError(provider: string): AppError {
  void provider;
  return new AppError('PROVIDER_NOT_CONFIGURED', FRIENDLY.PROVIDER_NOT_CONFIGURED.text, '', 'open-settings');
}
