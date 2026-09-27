# Metrics and the monitoring profile

Section 9.9 defines twelve metrics; `packages/metrics` declares all of them in
one registry, and `api`, `bot` and `worker` each export that registry. Every
process carries every name: a metric with no observations costs two lines of
text, and a dashboard that asks for `rr_revenue_minor_total` should find the
series whichever target answered the scrape.

| Metric                                           | Written by      | Where                                                                  |
| ------------------------------------------------ | --------------- | ---------------------------------------------------------------------- |
| `rr_http_requests_total{route,status}`           | `api`           | a global interceptor, labelled with the route template Fastify matched |
| `rr_http_request_duration_seconds`               | `api`           | the same interceptor                                                   |
| `rr_payments_events_total{provider,type,result}` | `api`           | every provider event, whichever way it ended                           |
| `rr_invoices_total{provider,status}`             | `api`           | creation, payment, cancellation and expiry                             |
| `rr_revenue_minor_total{provider}`               | `api`           | the one entry that moves money into `revenue`                          |
| `rr_panel_requests_total{op,status}`             | `api`           | `packages/remnawave-sdk`, once per operation                           |
| `rr_panel_request_duration_seconds{op}`          | `api`           | the same                                                               |
| `rr_queue_jobs{queue,state}`                     | `worker`        | sampled from BullMQ every fifteen seconds                              |
| `rr_bot_updates_total{type}`                     | `bot`           | each update taken off the stream                                       |
| `rr_notifications_total{event,status}`           | `api`           | every attempt, sent or skipped                                         |
| `rr_tls_cert_expiry_seconds`                     | `worker`, `api` | the daily `maintenance.tls-check` reading                              |
| `rr_ledger_audit_mismatch_total`                 | `api`           | the ledger audit, when it finds a disagreement                         |

Section 9.8 adds `rr_outgoing_webhook_failures_total` (`api`): every outgoing
webhook attempt that did not end in a 2xx, a retried one counted each time.

## The endpoints

```
GET http://api:3000/metrics
GET http://bot:3002/metrics
GET http://worker:3003/metrics
```

None of those ports is published (section 19.7). The proxy passes `/metrics`
through only from the compose network, and `api` checks the address again — a
container that reached `api:3000` directly never met the proxy. The check reads
`RR_TRUSTED_INTERNAL_CIDR`, which defaults to the compose subnet.

The proxies report on themselves too: nginx serves `stub_status` on
`127.0.0.1:8081/nginx_status` inside its container, for an exporter an owner
may add, and Caddy serves Prometheus text on a metrics-only port `:2020` (its
admin API stays on `localhost:2019` inside the container). The
shipped dashboard reads the application metrics, so neither is required.

## Turning monitoring on

It ships with the deployment and starts nothing:

```sh
docker compose --profile nginx --profile monitoring up -d
```

`prometheus` scrapes the three processes every fifteen seconds and keeps
fifteen days. `grafana` is provisioned with that datasource and with
`remnaray.json` — revenue, invoices by provider, provider events, queue depth,
panel requests and latency, HTTP errors and latency, notifications, Telegram
updates, certificate expiry, ledger mismatches and which targets are up.

Neither publishes a port. Reach Grafana over an SSH tunnel:

```sh
ssh -L 3010:localhost:3010 owner@server \
  docker compose exec grafana sleep infinity   # or add your own proxy rule
```

or, more simply, from the server itself:

```sh
docker compose --profile monitoring exec grafana wget -qO- http://127.0.0.1:3010/api/health
```

`RR_GRAFANA_PASSWORD` sets the administrator password, and `init-env.sh`
generates one. Grafana refuses to start without it, or with `admin`, rather
than come up with its own `admin`/`admin`; the rest of the stack is not
affected. Grafana takes the password when it first creates its database: to
change it on an existing install, run
`docker compose --profile monitoring exec grafana grafana cli admin reset-admin-password <new>`.

Alerts are not Prometheus's job here. Section 16.5 puts them in the
application, which knows the deployment's own thresholds and can reach the
owner over Telegram; Alertmanager is not part of the delivery.

## The `caddy` target under the nginx profile

`prometheus.yml` scrapes `proxy-caddy:2020` unconditionally, so under the nginx
profile that target reads `down`. That is the honest reading: nginx publishes
`stub_status`, which is not Prometheus text, and a target quietly removed would
hide a Caddy deployment whose metrics port stopped answering.
