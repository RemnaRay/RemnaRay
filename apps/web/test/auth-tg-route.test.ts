// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from '../app/auth/tg/route';

function request(headers: Record<string, string> = {}, token = 'jwt'): Request {
  return new Request(`http://shop.test/auth/tg?token=${token}`, { headers });
}

describe('/auth/tg picks the account locale (sections 13.1, 13.3)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('follows the rr_lang cookie first', () => {
    const response = GET(request({ cookie: 'rr_lang=en', 'accept-language': 'ru-RU' }));
    expect(response.headers.get('location')).toBe('/en/auth/tg#jwt');
  });

  // next-intl 4 sets `rr_lang` only when the locale differs from the browser's
  // `Accept-Language`, so a visitor reading `/en` in an English browser has
  // no cookie; the header is the next source in the section 13.1 order.
  it('falls back to Accept-Language when there is no cookie', () => {
    const response = GET(request({ 'accept-language': 'en-US,en;q=0.9' }));
    expect(response.headers.get('location')).toBe('/en/auth/tg#jwt');
  });

  it('honours the quality order of Accept-Language', () => {
    const response = GET(request({ 'accept-language': 'de-DE, en;q=0.5, ru;q=0.8' }));
    expect(response.headers.get('location')).toBe('/ru/auth/tg#jwt');
  });

  it('uses the default locale when neither names a supported one', () => {
    const response = GET(request({ 'accept-language': 'de-DE,fr;q=0.8' }));
    expect(response.headers.get('location')).toBe('/ru/auth/tg#jwt');
  });

  it('sends a visitor without a token to the login of their locale', () => {
    const response = GET(request({ 'accept-language': 'en' }, ''));
    expect(response.headers.get('location')).toBe('/en?login=1');
  });
});

// L-3 (owner decision 2026-09-28): the link no longer signs anybody in by
// itself. It opens the confirmation page, carrying the token in the fragment,
// which never reaches a server log or a `Referer`.
describe('/auth/tg signs nobody in by itself (L-3)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the API nothing and sets no cookie', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const response = GET(request({ 'accept-language': 'ru' }, 'a.b-c_d'));
    expect(fetch).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('location')).toBe('/ru/auth/tg#a.b-c_d');
  });
});
