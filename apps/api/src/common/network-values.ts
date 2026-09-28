/**
 * Values the proxy renderer pastes into the nginx and Caddy configurations as
 * they are (R58): only a host name or an IP range may get there, never a
 * character that ends a directive or a block.
 */
import { isIP } from 'node:net';
import { z } from 'zod';

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

export const hostNameSchema = z
  .string()
  .min(1)
  .max(253)
  .refine(isHostName, { message: 'Must be a host name' });

export const ipOrCidrSchema = z
  .string()
  .refine(isIpOrCidr, { message: 'Must be an IP address or a CIDR range' });
