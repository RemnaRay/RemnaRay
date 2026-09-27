/**
 * Section 19.1: `payment_events.raw` is stored with the provider's secret
 * fields masked — `secret`, `token`, `password`, `Signature*`, `X-Secret`.
 * The signature has been checked against the unmasked body by then; the
 * stored copy is for audit, and a `SignatureValue` in a database dump or a
 * backup would let Robokassa's `Password2` be brute-forced offline.
 */
const SECRET_KEY = /secret|token|password|signature/iu;

export function maskEventRaw(value: unknown, depth = 0): unknown {
  if (depth > 10) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => maskEventRaw(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? '***' : maskEventRaw(item, depth + 1),
    ]),
  );
}

/**
 * The request headers kept with an event: what identifies the request, and
 * the source IP section 19.5 lists — never cookies, authorization or the
 * providers' signature headers.
 */
const STORED_HEADERS = ['content-type', 'user-agent', 'x-request-id'] as const;

export function eventHeaders(headers: Record<string, string>, ip: string): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of STORED_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string') kept[name] = value;
  }
  kept.ip = ip;
  return kept;
}
