import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/** Section 9.9, written out here rather than imported: a test that reads the
 * implementation's own list cannot tell whether the list is right. */
const SECTION_9_9_METRICS = [
  'rr_http_requests_total',
  'rr_http_request_duration_seconds',
  'rr_payments_events_total',
  'rr_invoices_total',
  'rr_revenue_minor_total',
  'rr_panel_requests_total',
  'rr_panel_request_duration_seconds',
  'rr_queue_jobs',
  'rr_bot_updates_total',
  'rr_notifications_total',
  'rr_tls_cert_expiry_seconds',
  'rr_ledger_audit_mismatch_total',
];

const metricsSource = await readFile('packages/metrics/src/index.ts', 'utf8');
const dashboard = JSON.parse(
  await readFile('deploy/monitoring/grafana/dashboards/remnaray.json', 'utf8'),
);
const prometheus = await readFile('deploy/monitoring/prometheus.yml', 'utf8');
const monitoring = await readFile('deploy/monitoring/compose.monitoring.yaml', 'utf8');
const compose = await readFile('compose.yaml', 'utf8');

/** Every PromQL expression the dashboard runs. */
const expressions = dashboard.panels.flatMap((panel) => panel.targets.map((target) => target.expr));

test('the monitoring profile is part of the deployment and starts nothing by default', () => {
  assert.match(compose, /include:\n {2}- path: deploy\/monitoring\/compose\.monitoring\.yaml/u);
  for (const service of ['prometheus', 'grafana'])
    assert.match(
      monitoring,
      new RegExp(`${service}:[\\s\\S]*?profiles: \\[monitoring\\]`, 'u'),
      `${service} must be behind the monitoring profile`,
    );
  // Section 19.7: the application ports are `expose`, and so are these.
  assert.doesNotMatch(monitoring, /^\s*ports:/mu);
});

test('Prometheus scrapes every process that carries section 9.9 metrics', () => {
  for (const target of ['api:3000', 'bot:3002', 'worker:3003'])
    assert.ok(prometheus.includes(target), `prometheus.yml does not scrape ${target}`);
  // Section 20.2: Caddy answers Prometheus; nginx does not. R137 (owner
  // decision О-14): on a metrics-only port, since the admin API that used to
  // serve them accepts configuration from anyone who reaches it.
  assert.ok(prometheus.includes('proxy-caddy:2020'));
  assert.ok(!prometheus.includes('proxy-caddy:2019'));
});

test('the dashboard reads the section 9.9 metrics and nothing invented', () => {
  const used = new Set();
  for (const expression of expressions)
    for (const name of expression.matchAll(/rr_[a-z_]+/gu)) used.add(name[0]);

  for (const name of used) {
    const base = name.replace(/_(bucket|sum|count)$/u, '');
    assert.ok(
      SECTION_9_9_METRICS.includes(base),
      `the dashboard reads ${name}, which section 9.9 does not define`,
    );
  }

  // Section 20.2 names what the dashboard has to show.
  const required = [
    'rr_revenue_minor_total',
    'rr_invoices_total',
    'rr_queue_jobs',
    'rr_panel_requests_total',
    'rr_http_requests_total',
    'rr_tls_cert_expiry_seconds',
  ];
  for (const name of required)
    assert.ok(
      [...used].some((metric) => metric.startsWith(name)),
      `${name} is not on the board`,
    );
});

test('every dashboard panel names the provisioned datasource', () => {
  assert.equal(dashboard.uid, 'remnaray');
  for (const panel of dashboard.panels) {
    assert.equal(panel.datasource.uid, 'remnaray-prometheus', `${panel.title} has no datasource`);
    assert.ok(panel.title.length > 0);
  }
});

test('the metrics package declares exactly the section 9.9 names', () => {
  for (const name of SECTION_9_9_METRICS)
    assert.ok(
      metricsSource.includes(`name: '${name}'`),
      `packages/metrics does not declare ${name}`,
    );
});
