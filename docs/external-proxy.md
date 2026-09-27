# Using your own reverse proxy

`RR_PROXY_PROFILE=external` tells RemnaRay to terminate nothing: no
`proxy-nginx`, no `proxy-caddy`, no `proxy-config`, no `proxy-reloader` and no
`certbot`. In their place a single `edge` container publishes one upstream on
`127.0.0.1:${RR_EXTERNAL_HTTP_PORT}` (8080 by default), so your proxy talks to
one address instead of having to route between `api` and `web` itself.

```
your proxy ──► 127.0.0.1:8080 (edge) ──┬─► api:3000   /api, /webhooks, /tg
                                       └─► web:3001   everything else
```

`/api/internal/*` and `/metrics` are answered by `edge` itself with `404`: the
bot and the worker reach the API on the compose network, and Prometheus
scrapes `api:3000/metrics` there too, never through your proxy.

`RR_TLS_MODE` must be `none`, and the environment validation enforces that both
ways: `none` is refused with any other profile, and any other mode is refused
with `external`.

## What RemnaRay expects from you

| Header              | Why                                                 |
| ------------------- | --------------------------------------------------- |
| `Host`              | the shop's own domain, not your proxy's             |
| `X-Forwarded-Proto` | must be `https`; cookies and redirects depend on it |
| `X-Forwarded-For`   | the real client address, appended not replaced      |
| `X-Real-IP`         | optional, the same address                          |

`RR_TRUSTED_PROXIES` is **required** and is the whole of the security here: it
is a comma-separated list of the addresses allowed to set those headers. A
request that arrives from anywhere else keeps its source address no matter what
it claims.

The API never sees your proxy directly: its peer is the `edge` container, and
your proxy's connection to `127.0.0.1:8080` reaches `edge` from the compose
network's gateway. Both are in the compose network, so the list **starts with
`172.28.0.0/16`** — the default — and adds what sits in front of `edge`: nothing
more for a proxy on the same host, your proxy's subnet for one elsewhere,
Cloudflare's published ranges behind Cloudflare. A list without the compose
network makes every visitor look like `edge`: one rate-limit bucket, one
setup-token lock and one audit address for the whole shop.

You own TLS, rate limiting and the security headers. RemnaRay does not add them
in this profile, because two sources of the same header means two places to
change and two chances to disagree.

## nginx on the host

```nginx
server {
    listen 443 ssl;
    server_name shop.example.com;

    ssl_certificate     /etc/letsencrypt/live/shop.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/shop.example.com/privkey.pem;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;

    location / {
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        client_max_body_size 10m;
        proxy_pass http://127.0.0.1:8080;
    }
}
```

With this, the default `RR_TRUSTED_PROXIES=172.28.0.0/16` is right as it is.

## Traefik

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.remnaray.rule=Host(`shop.example.com`)
  - traefik.http.routers.remnaray.entrypoints=websecure
  - traefik.http.routers.remnaray.tls.certresolver=letsencrypt
  - traefik.http.services.remnaray.loadbalancer.server.port=8080
```

Traefik sets `X-Forwarded-*` itself. Add its container network to
`RR_TRUSTED_PROXIES` after `172.28.0.0/16`.

## Cloudflare

Use **Full (strict)** so the connection to your origin is encrypted and
verified, and add a rule that does not cache `/api/*`, `/webhooks/*` or
`/tg/*` — those are never cacheable and a cached answer would break payments.

Cloudflare sends the client address in `CF-Connecting-IP` as well as
`X-Forwarded-For`. Set `RR_TRUSTED_PROXIES` to
[Cloudflare's IP ranges](https://www.cloudflare.com/ips/) so the forwarded
address is believed (`172.28.0.0/16,` followed by the ranges); without that
the shop sees Cloudflare's address as the client for every request, and the
rate limits become useless.

## Checking it

`GET /api/admin/v1/system` reports what the last request actually carried:

```json
"proxy": {
  "profile": "external",
  "trustedProxies": "172.28.0.0/16",
  "external": {
    "at": "2026-09-20T12:00:00.000Z",
    "clientIp": "203.0.113.7",
    "protocol": "https",
    "forwardedFor": true,
    "forwardedProto": true
  }
}
```

`forwardedProto: false`, or a `clientIp` that is your proxy rather than a real
visitor, means the headers are not arriving or `RR_TRUSTED_PROXIES` does not
include your proxy.
