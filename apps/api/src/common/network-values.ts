/**
 * Values the proxy renderer pastes into the nginx and Caddy configurations as
 * they are (R58): only a host name or an IP range may get there, never a
 * character that ends a directive or a block. Plain predicates: the renderer
 * uses them too, and it loads nothing but Node's own modules.
 */
import { isIP } from 'node:net';

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/iu;

export function isHostName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && HOST.test(value);
}

/** An IPv4 or IPv6 address, or one with a `/prefix` its family allows. */
export function isIpOrCidr(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const [address = '', prefix, ...rest] = value.split('/');
  const family = isIP(address);
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/u.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

/** An ACME contact address: nothing a configuration could read as syntax. */
export function isContactEmail(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 254 &&
    /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/u.test(
      value,
    )
  );
}
