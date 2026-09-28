import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';

/**
 * P-21 (owner decision О-17), the deployment's own `valkey` service: a client
 * without the password is refused, the healthcheck still passes, and the
 * password is on no command line in the container.
 */
test('P-21: the compose Valkey refuses a client without the password', { timeout: 300_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'rr-valkey-'));
  const project = `rrvalkey${String(process.pid)}`;
  const password = 'p21-valkey-password-0123456789';
  const compose = (...args) =>
    execFileSync('docker', ['compose', '-p', project, '--project-directory', directory, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    cpSync('compose.yaml', join(directory, 'compose.yaml'));
    cpSync('deploy/monitoring', join(directory, 'deploy/monitoring'), { recursive: true });
    writeFileSync(
      join(directory, '.env'),
      readFileSync('.env.example', 'utf8').replace(
        /^VALKEY_PASSWORD=.*$/mu,
        `VALKEY_PASSWORD=${password}`,
      ),
    );
    compose('up', '-d', '--wait', 'valkey');

    const cli = (...args) =>
      spawnSync(
        'docker',
        ['compose', '-p', project, '--project-directory', directory, 'exec', '-T', ...args],
        { encoding: 'utf8' },
      );
    // Without the password (the service's VALKEYCLI_AUTH emptied): refused.
    const anonymous = cli(
      '-e',
      'VALKEYCLI_AUTH=',
      'valkey',
      'valkey-cli',
      'set',
      'rr:asess:x',
      '1',
    );
    assert.match(anonymous.stdout + anonymous.stderr, /NOAUTH/u);
    // With it, as the healthcheck and `rr proxy:reload` run it.
    assert.equal(cli('valkey', 'valkey-cli', 'ping').stdout.trim(), 'PONG');
    // No process in the container carries it in its arguments.
    const processes = cli('valkey', 'sh', '-c', 'cat /proc/[0-9]*/cmdline | tr "\\0" " "').stdout;
    assert.match(processes, /valkey-server/u);
    assert.ok(!processes.includes(password), processes);

    // Without VALKEY_PASSWORD in `.env`, compose refuses to run at all.
    writeFileSync(
      join(directory, '.env'),
      readFileSync('.env.example', 'utf8').replace(/^VALKEY_PASSWORD=.*$/mu, ''),
    );
    const missing = spawnSync(
      'docker',
      ['compose', '-p', project, '--project-directory', directory, 'config', '--quiet'],
      { encoding: 'utf8' },
    );
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /VALKEY_PASSWORD/u);
  } finally {
    spawnSync('docker', ['compose', '-p', project, '--project-directory', directory, 'down', '-v']);
    rmSync(directory, { recursive: true, force: true });
  }
});
