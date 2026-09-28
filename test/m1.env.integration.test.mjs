import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';

/**
 * R67, section 17.2: a process started with an environment `packages/config`
 * refuses stops at once, naming the variables and never their values. Here
 * `RR_TLS_MODE=acme` without `RR_ACME_EMAIL`, and a key that is not 32 bytes.
 */
test('M1 the api, worker and bot refuse a wrong environment at start', () => {
  const environment = {
    PATH: process.env.PATH,
    RR_DOMAIN: 'shop.example.test',
    RR_PROXY_PROFILE: 'nginx',
    RR_TLS_MODE: 'acme',
    RR_APP_KEY: 'not-a-32-byte-key-value',
    RR_SETUP_TOKEN: 'setup',
    RR_INTERNAL_TOKEN: 'internal',
    POSTGRES_PASSWORD: 'database-password',
    // Nothing is listening here: a process that got past the check would
    // hang on it rather than exit.
    DATABASE_URL: 'postgresql://remnaray:x@127.0.0.1:9/remnaray',
    VALKEY_URL: 'redis://127.0.0.1:9/0',
  };
  for (const app of ['api', 'worker', 'bot']) {
    const result = spawnSync('node', [`apps/${app}/dist/main.js`], {
      env: environment,
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(result.error, undefined, `${app} did not exit: ${String(result.error)}`);
    assert.notEqual(result.status, 0, app);
    assert.match(result.stderr, /RR_ACME_EMAIL/u, `${app}: ${result.stderr}`);
    assert.match(result.stderr, /RR_APP_KEY/u, app);
    assert.doesNotMatch(result.stderr, /not-a-32-byte-key-value|database-password/u, app);
  }
});
