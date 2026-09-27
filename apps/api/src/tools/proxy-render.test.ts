import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  caddyHasRateLimit,
  certbotCertificatePresent,
  customFiles,
  fill,
  renderProfile,
  sourcesFrom,
  writeAtomically,
  type ProxySources,
  type TlsMode,
} from './proxy-render';

// The API compiles to CommonJS (section 6.1), so `__dirname` is the portable
// anchor here; Vitest provides it for the TypeScript source as well.
const proxyRoot = resolve(__dirname, '../../../../deploy/proxy');
const templates = resolve(proxyRoot, 'nginx');

const sources: ProxySources = {
  domain: 'shop.example.com',
  extraDomains: [],
  acmeEmail: 'ops@example.com',
  adminAllowlist: [],
  dockerCidr: '172.28.0.0/16',
  apiDocs: false,
  internalApi: false,
  caddyRateLimit: true,
};

function render(tlsMode: TlsMode, overrides: Partial<ProxySources> = {}, certificate = true) {
  const files = renderProfile(
    templates,
    { ...sources, ...overrides },
    { profile: 'nginx', tlsMode, certificatePresent: certificate },
  );
  return new Map(files.map((file) => [file.name, file.content]));
}

describe('proxy template rendering (section 21.2)', () => {
  it('uses a readable issuance marker instead of Certbot private-key permissions', () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-certbot-state-'));
    try {
      expect(certbotCertificatePresent('shop.example.com', root)).toBe(false);
      writeFileSync(join(root, 'certificates.json'), '["shop.example.com"]\n', { mode: 0o644 });
      expect(certbotCertificatePresent('shop.example.com', root)).toBe(true);
      expect(certbotCertificatePresent('other.example.com', root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('substitutes only `{{NAME}}` placeholders and leaves unknown ones alone', () => {
    expect(fill('a {{ONE}} b {{TWO}} c', { ONE: '1' })).toBe('a 1 b {{TWO}} c');
  });

  it('limits sign-in POSTs only, and counts the console session in the console zone (F17)', () => {
    const files = render('acme');
    const site = files.get('site.conf') ?? '';
    const limits = files.get('ratelimits.inc') ?? '';
    const location = (path: string) => {
      const start = site.indexOf(`location ^~ ${path} {`);
      return site.slice(start, site.indexOf('}', start));
    };
    expect(limits).toMatch(
      /map \$request_method \$rr_signin_key \{\s*POST\s+\$binary_remote_addr;\s*default\s+"";\s*\}/u,
    );
    expect(limits).toMatch(/limit_req_zone \$rr_signin_key\s+zone=rr_signin:10m\s+rate=5r\/m;/u);
    expect(limits).toMatch(/zone=rr_admin:10m\s+rate=120r\/m;/u);
    expect(location('/api/admin/v1/auth/')).toContain('limit_req zone=rr_signin burst=10 nodelay;');
    expect(location('/api/admin/v1/auth/')).toContain('limit_req zone=rr_admin burst=120 nodelay;');
    expect(location('/api/admin/v1/auth/')).not.toContain('zone=rr_auth');
    expect(location('/api/v1/auth/')).toContain('limit_req zone=rr_signin burst=10 nodelay;');
    expect(location('/api/admin/')).toContain('limit_req zone=rr_admin burst=120 nodelay;');
    expect(location('/api/setup/')).toContain('zone=rr_auth');
  });

  it('renders the whole nginx set for every TLS mode', () => {
    for (const mode of ['acme', 'certbot', 'custom'] as const) {
      const files = render(mode);
      expect([...files.keys()].sort()).toEqual(
        [
          'common-proxy.inc',
          'nginx.conf',
          'ratelimits.inc',
          'security-headers.inc',
          'site.conf',
          `tls-${mode}.inc`,
          'tls-cert.inc',
        ].sort(),
      );
      expect(files.get('nginx.conf')).toContain(`include /etc/nginx/conf.d/tls-${mode}.inc;`);
      expect(files.get('nginx.conf')).toContain('set_real_ip_from 172.28.0.0/16;');
      expect(files.get('site.conf')).toContain('server_name shop.example.com;');
      expect(files.get('site.conf')).not.toContain('{{');
      expect(files.get('nginx.conf')).not.toContain('{{');
    }
  });

  it('loads the ACME module only in `acme` mode', () => {
    expect(render('acme').get('nginx.conf')).toContain(
      'load_module modules/ngx_http_acme_module.so;',
    );
    expect(render('certbot').get('nginx.conf')).not.toContain('load_module');
    expect(render('acme').get('tls-cert.inc')).toContain('acme_certificate letsencrypt;');
    expect(render('certbot').get('tls-cert.inc')).toContain(
      '/etc/letsencrypt/live/shop.example.com/fullchain.pem',
    );
    expect(render('custom').get('tls-cert.inc')).toContain('/etc/nginx/certs/fullchain.pem');
  });

  it('renders the HTTP-only bootstrap while certbot has no certificate', () => {
    const bootstrap = render('certbot', {}, false).get('site.conf') ?? '';
    expect(bootstrap).not.toContain('listen 443');
    expect(bootstrap).toContain('/.well-known/acme-challenge/');
    expect(render('certbot', {}, true).get('site.conf')).toContain('listen 443 ssl;');
  });

  it('exposes nginx`s own counters on loopback inside the container', () => {
    const conf = render('acme').get('nginx.conf') ?? '';

    // Section 20.2: `127.0.0.1:8081/nginx_status`, reachable from nowhere
    // else — the port is not published and not in any `expose`.
    expect(conf).toContain('listen 127.0.0.1:8081;');
    expect(conf).toContain('location = /nginx_status { stub_status; }');
  });

  it('answers a non-POST webhook with 405, like the Caddy profile (section 21.5)', () => {
    const site = render('acme').get('site.conf') ?? '';
    const methodGate = 'if ($request_method != POST) { return 405; }';
    const bodyOf = (location: string) =>
      site.slice(site.indexOf(location), site.indexOf('proxy_pass', site.indexOf(location)));

    // `limit_except POST { deny all; }` answers 403, and the invariant of
    // section 21.5 is that the status does not depend on the profile.
    expect(site).not.toContain('limit_except POST');
    // A zone that queues instead of refusing makes the same request slow on
    // one profile and refused on the other.
    expect(site).not.toMatch(/limit_req zone=\w+ burst=\d+;/u);
    expect(bodyOf('location ^~ /webhooks/ {')).toContain(methodGate);
    expect(bodyOf('location ^~ /tg/webhook/ {')).toContain(methodGate);
  });

  it('adds the redirect server only when there are extra domains', () => {
    expect(render('acme').get('site.conf')).not.toContain('return 301 https://shop.example.com');
    const withExtra = render('acme', { extraDomains: ['www.example.com', 'shop.example.net'] });
    expect(withExtra.get('site.conf')).toContain('server_name www.example.com shop.example.net;');
    expect(withExtra.get('site.conf')).toContain(
      'return 301 https://shop.example.com$request_uri;',
    );
    expect(withExtra.get('site.conf')).toContain(
      'server_name shop.example.com www.example.com shop.example.net;',
    );
  });

  it('renders the administration allowlist and the API docs denial', () => {
    const open = render('acme').get('site.conf') ?? '';
    expect(open).not.toContain('allow 203.0.113.0/24;');
    expect(open).toContain('location = /api/docs {\n        deny all;');

    const restricted =
      render('acme', { adminAllowlist: ['203.0.113.0/24', '198.51.100.7'], apiDocs: true }).get(
        'site.conf',
      ) ?? '';
    expect(restricted).toContain(
      '        allow 203.0.113.0/24;\n        allow 198.51.100.7;\n        deny all;',
    );
    expect(restricted).not.toContain(
      'deny all;\n        proxy_pass http://rr_api;\n    }\n    # --- the public API',
    );
  });

  it('refuses `none`, which section 21.7 reserves for the external profile', () => {
    expect(() => render('none')).toThrow(/external profile/u);
  });

  it('carries the owner`s `custom.d` files through untouched', () => {
    const files = customFiles(templates);
    expect(files.every((file) => file.name.startsWith('custom.d/'))).toBe(true);
  });
});

describe('proxy sources and atomic writes', () => {
  it('prefers the stored settings and falls back to the environment', () => {
    process.env.RR_DOMAIN = 'env.example.com';
    expect(sourcesFrom([])).toMatchObject({ domain: 'env.example.com', extraDomains: [] });
    expect(
      sourcesFrom([
        { key: 'domain.main', value: 'db.example.com' },
        { key: 'domain.extra_domains', value: ['www.example.com', 7] },
        { key: 'admin.ip_allowlist', value: ['203.0.113.0/24'] },
      ]),
    ).toMatchObject({
      domain: 'db.example.com',
      extraDomains: ['www.example.com'],
      adminAllowlist: ['203.0.113.0/24'],
    });
  });

  it('writes only what changed, and reports whether anything did', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rr-proxy-'));
    try {
      const files = [{ name: 'nginx.conf', content: 'one' }];
      expect(writeAtomically(directory, files)).toBe(true);
      expect(readFileSync(resolve(directory, 'nginx.conf'), 'utf8')).toBe('one');
      expect(writeAtomically(directory, files)).toBe(false);
      expect(writeAtomically(directory, [{ name: 'nginx.conf', content: 'two' }])).toBe(true);
      expect(readFileSync(resolve(directory, 'nginx.conf'), 'utf8')).toBe('two');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function renderCaddy(tlsMode: TlsMode, overrides: Partial<ProxySources> = {}) {
  const files = renderProfile(
    resolve(proxyRoot, 'caddy'),
    { ...sources, ...overrides },
    { profile: 'caddy', tlsMode, certificatePresent: true },
  );
  return files.find((file) => file.name === 'Caddyfile')?.content ?? '';
}

describe('Caddy template rendering (section 21.4)', () => {
  it('renders one Caddyfile with every placeholder resolved', () => {
    const caddyfile = renderCaddy('acme');

    expect(caddyfile).not.toContain('{{');
    expect(caddyfile).toContain('email ops@example.com');
    expect(caddyfile).toContain('trusted_proxies static 172.28.0.0/16');
    expect(caddyfile).toContain('shop.example.com {');
    expect(caddyfile).toContain('reverse_proxy api:3000');
    expect(caddyfile).toContain('handle @webhooks_bad_method {');
  });

  it('carries the rate-limit zones only when the image has the module', () => {
    const withModule = renderCaddy('acme');
    expect(withModule).toContain('order rate_limit before basicauth');
    for (const zone of ['rr_webhooks', 'rr_auth', 'rr_admin', 'rr_api', 'rr_general'])
      expect(withModule).toContain(`zone ${zone} {`);

    const stock = renderCaddy('acme', { caddyRateLimit: false });
    expect(stock).not.toContain('rate_limit');
    expect(stock).not.toContain('order rate_limit');
  });

  it('knows which image carries `caddy-ratelimit`', () => {
    expect(caddyHasRateLimit('ghcr.io/remnaray/caddy:1')).toBe(true);
    expect(caddyHasRateLimit(undefined)).toBe(true);
    expect(caddyHasRateLimit('caddy:2-alpine')).toBe(false);
    expect(caddyHasRateLimit('docker.io/library/caddy:2')).toBe(false);
  });

  it('names the owner`s certificate only in `custom` mode, and refuses certbot', () => {
    expect(renderCaddy('acme')).not.toContain('tls /certs');
    expect(renderCaddy('custom')).toContain('tls /certs/fullchain.pem /certs/privkey.pem');
    expect(() => renderCaddy('certbot')).toThrow(/certbot is not supported/u);
  });

  it('refuses inside a `handle`, which is ordered before the catch-all', () => {
    const caddyfile = renderCaddy('acme');

    // A bare `respond @matcher` is ordered after `handle`, so the catch-all
    // would answer first: a non-POST webhook became a 307 to the site and
    // `/metrics` from outside reached `api` and became a 404.
    expect(caddyfile).not.toMatch(/^\s*respond @\w+ \d+$/mu);
    for (const matcher of ['@webhooks_bad_method', '@tg_bad_method', '@metrics'])
      expect(caddyfile).toContain(`handle ${matcher} {`);
  });

  it('carries the same allowance per zone as the nginx profile', () => {
    const caddyfile = renderCaddy('acme');

    // nginx spends `rate × window + burst`; Caddy has no burst, so the events
    // are that sum. With the rate alone, a sign-in the nginx profile serves
    // is refused here (section 21.5).
    for (const [zone, events] of [
      ['rr_auth', 15],
      ['rr_admin', 240],
      ['rr_api', 130],
      ['rr_general', 250],
      ['rr_webhooks', 360],
    ])
      expect(caddyfile).toMatch(
        new RegExp(
          `zone ${String(zone)} \\{\\s*key \\{client_ip\\}\\s*events ${String(events)}\\b`,
          'u',
        ),
      );
  });

  it('limits sign-in POSTs only, and lets the console session read itself in the console zone (F17)', () => {
    const caddyfile = renderCaddy('acme');
    const block = (path: string) => {
      const start = caddyfile.indexOf(`handle ${path} {`);
      return caddyfile.slice(start, caddyfile.indexOf('reverse_proxy', start));
    };
    const signin =
      /zone rr_signin \{\s*match \{\s*method POST\s*\}\s*key \{client_ip\}\s*events 15\b/u;
    expect(block('/api/admin/v1/auth/*')).toMatch(signin);
    expect(block('/api/admin/v1/auth/*')).toMatch(
      /zone rr_admin \{\s*key \{client_ip\}\s*events 240\b/u,
    );
    expect(block('/api/admin/v1/auth/*')).not.toContain('zone rr_auth ');
    expect(block('/api/v1/auth/*')).toMatch(signin);
    expect(block('/api/v1/auth/*')).toMatch(/zone rr_api \{/u);
    // The setup wizard keeps the section 21.3 zone.
    expect(block('/api/setup/*')).toContain('zone rr_auth {');
  });

  it('answers /healthz and redirects with 301 on :80, like the nginx profile', () => {
    const caddyfile = renderCaddy('acme');

    // Section 21.5: the compose health check asks 127.0.0.1 for `/healthz`
    // with no `Host`, and section 26.4 A3 expects `http://` to answer 301.
    expect(caddyfile).toContain('auto_https disable_redirects');
    expect(caddyfile).toContain('http:// {');
    const httpSite = caddyfile.slice(caddyfile.indexOf('http:// {'));
    expect(httpSite).toContain('respond "ok" 200');
    expect(httpSite).toContain('redir https://{host}{uri} permanent');
  });

  it('names an ACME account only when there is one', () => {
    expect(renderCaddy('acme')).toContain('email ops@example.com');

    // `custom` mode needs no account, and `email` with nothing after it is a
    // parse error that stops Caddy from starting at all.
    const owned = renderCaddy('custom', { acmeEmail: '' });
    expect(owned).not.toMatch(/^\s*email\s*$/mu);
    expect(owned).not.toContain('email');
  });

  it('adds the redirect site and the administration allowlist only when they apply', () => {
    expect(renderCaddy('acme')).not.toContain('redir https://shop.example.com');
    expect(renderCaddy('acme')).toContain('handle /api/docs {');

    const restricted = renderCaddy('acme', {
      extraDomains: ['www.example.com', 'shop.example.net'],
      adminAllowlist: ['203.0.113.0/24'],
      apiDocs: true,
    });
    expect(restricted).toContain('www.example.com, shop.example.net {');
    expect(restricted).toContain('redir https://shop.example.com{uri} permanent');
    // The redirect site would otherwise try to issue its own certificate,
    // which `custom` mode has no issuance for at all — and each directive
    // needs its own line, or Caddy refuses the whole file.
    expect(renderCaddy('custom', { extraDomains: ['www.example.com'] })).toContain(
      ['www.example.com {', '\ttls /certs/fullchain.pem /certs/privkey.pem', '\tredir'].join('\n'),
    );
    expect(restricted).toContain('@rr_denied not client_ip 203.0.113.0/24');
    expect(restricted).not.toContain('handle /api/docs {');
  });
});

describe('the internal API is not published (section 9.5)', () => {
  it('nginx answers /api/internal/ itself with 404 unless the smoke stand opens it', () => {
    const closed = render('acme').get('site.conf') ?? '';
    expect(closed).toContain('location ^~ /api/internal/ {\n        return 404;\n    }');

    const stand = render('acme', { internalApi: true }).get('site.conf') ?? '';
    expect(stand).toMatch(/location \^~ \/api\/internal\/ \{\n[^}]*proxy_pass http:\/\/rr_api;/u);
    expect(stand).not.toContain('return 404;\n    }\n    # --- metrics');
  });

  it('Caddy answers it in a `handle`, which wins over `handle /api/*`', () => {
    const closed = renderCaddy('acme');
    expect(closed).toContain('\thandle /api/internal/* {\n\t\trespond 404\n\t}');
    expect(renderCaddy('acme', { internalApi: true })).not.toContain('handle /api/internal/*');
  });

  it('Caddy closes /api/docs in a `handle` too: a bare `respond` ran after `handle /api/*`', () => {
    const closed = renderCaddy('acme');
    expect(closed).not.toMatch(/^\s*respond \/api\/docs 404$/mu);
    expect(closed).toContain('\thandle /api/docs {\n\t\trespond 404\n\t}');
    expect(renderCaddy('acme', { apiDocs: true })).not.toContain('handle /api/docs');
  });

  it('the external profile`s edge refuses it as well', () => {
    const edge = readFileSync(resolve(proxyRoot, 'external/edge.conf'), 'utf8');
    expect(edge).toMatch(/location \^~ \/api\/internal\/ \{ return 404; \}/u);
  });

  it('only the smoke stand`s test mode opens it', () => {
    const previous = process.env.RR_ECHO_HEADERS;
    try {
      delete process.env.RR_ECHO_HEADERS;
      expect(sourcesFrom([]).internalApi).toBe(false);
      process.env.RR_ECHO_HEADERS = 'true';
      expect(sourcesFrom([]).internalApi).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.RR_ECHO_HEADERS;
      else process.env.RR_ECHO_HEADERS = previous;
    }
  });
});

describe('edge access log (section 19.6, R4)', () => {
  // nginx's default `combined` format writes `$request`, the full request line
  // with its query string — `/auth/tg?token=<jwt>` in the external profile.
  it('logs the path without its query string', () => {
    const edge = readFileSync(resolve(proxyRoot, 'external/edge.conf'), 'utf8');
    const accessLog = /^\s*access_log\s+\/dev\/stdout\s+(\w+);/mu.exec(edge);
    expect(accessLog?.[1], 'a named JSON format, not the default combined').toBeDefined();
    const format = new RegExp(`log_format ${accessLog?.[1] ?? '-'}[^;]+;`, 'u').exec(edge)?.[0];
    expect(format).toBeDefined();
    expect(format).not.toMatch(/\$request\b|\$request_uri|\$args|\$query_string/u);
    // A page opened from `/auth/tg?token=` sends that URL as the `Referer`
    // of its assets.
    expect(format).not.toContain('$http_referer');
  });
});
