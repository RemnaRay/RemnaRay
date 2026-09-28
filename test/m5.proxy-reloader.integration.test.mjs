import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Buffer } from 'node:buffer';
import { GenericContainer } from 'testcontainers';

/**
 * A Docker Engine stand-in on a unix socket, answering the three calls
 * `dockerExec` makes. Each exec start is held until the test releases it, so
 * a reload can be kept in progress for as long as the test needs.
 */
function fakeEngine(socketPath) {
  const commands = [];
  const held = [];
  let next = 0;
  const execs = new Map();
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '';
      response.setHeader('content-type', 'application/json');
      if (/\/containers\/[^/]+\/exec$/u.test(url)) {
        next += 1;
        const id = `exec${String(next)}`;
        execs.set(id, JSON.parse(Buffer.concat(chunks).toString('utf8')).Cmd);
        response.writeHead(201);
        response.end(JSON.stringify({ Id: id }));
        return;
      }
      const start = /\/exec\/([^/]+)\/start$/u.exec(url);
      if (start) {
        commands.push(execs.get(start[1]));
        held.push(() => {
          response.writeHead(200);
          response.end();
        });
        return;
      }
      response.writeHead(200);
      response.end(JSON.stringify({ ExitCode: 0 }));
    });
  });
  return {
    commands,
    listen: () => new Promise((done) => server.listen(socketPath, done)),
    /** Lets every exec started so far finish. */
    release: () => {
      for (const finish of held.splice(0)) finish();
    },
    close: () => new Promise((done) => server.close(done)),
  };
}

async function waitFor(condition, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/**
 * Section 21.6: a reload requested while one is running must still be
 * applied. `render-proxy` writes the new files and then publishes; the
 * running reload's `nginx -t` may already have read the old ones, so a
 * request it swallowed would leave the new configuration unapplied until
 * some later change.
 */
test(
  'M5 proxy-reloader applies a reload requested while one is running',
  { timeout: 120_000 },
  async () => {
    const valkey = await new GenericContainer('valkey/valkey:9.1-alpine')
      .withExposedPorts(6379)
      .start();
    const directory = mkdtempSync(join(tmpdir(), 'rr-reloader-'));
    const engine = fakeEngine(join(directory, 'docker.sock'));
    await engine.listen();
    const api = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end('{"recorded":true}');
      });
    });
    await new Promise((done) => api.listen(0, '127.0.0.1', done));
    const valkeyUrl = `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}/0`;
    const reloader = spawn(
      'node',
      ['apps/api/dist/tools/proxy-reloader.js', '--profile', 'nginx'],
      {
        env: {
          ...process.env,
          VALKEY_URL: valkeyUrl,
          DOCKER_SOCKET: join(directory, 'docker.sock'),
          RR_PROXY_CONTAINER: 'proxy',
          INTERNAL_API_URL: `http://127.0.0.1:${String(api.address().port)}`,
          RR_INTERNAL_TOKEN: 'proxy-reloader-test',
        },
        stdio: 'pipe',
      },
    );
    const log = [];
    for (const stream of [reloader.stdout, reloader.stderr])
      stream.on('data', (chunk) => log.push(String(chunk)));
    const publish = () => valkey.exec(['valkey-cli', 'publish', 'rr:proxy.reload', '1']);
    const tests = () => engine.commands.filter((command) => command.includes('-t')).length;

    try {
      await waitFor(
        () => log.join('').includes('watching rr:proxy.reload'),
        30_000,
        'the reloader',
      );

      // The first reload is in `nginx -t` and held there.
      await publish();
      await waitFor(() => tests() === 1, 10_000, 'the first nginx -t');
      // The next configuration is written and announced meanwhile.
      await publish();
      await sleep(500);
      engine.release();
      await waitFor(() => engine.commands.length >= 2, 10_000, 'the first reload');
      engine.release();

      // The second request is applied after the first: a fresh `nginx -t`
      // and reload, not dropped.
      await waitFor(() => tests() === 2, 10_000, `a second nginx -t\n${log.join('')}`);
      engine.release();
      await waitFor(() => engine.commands.length === 4, 10_000, 'the second reload');
      engine.release();
      assert.deepEqual(
        engine.commands.map((command) => command.slice(1).join(' ')),
        [
          '-t -c /etc/nginx/conf.d/nginx.conf',
          '-c /etc/nginx/conf.d/nginx.conf -s reload',
          '-t -c /etc/nginx/conf.d/nginx.conf',
          '-c /etc/nginx/conf.d/nginx.conf -s reload',
        ],
      );

      // Several requests during one reload collapse into one more reload.
      await publish();
      await waitFor(() => tests() === 3, 10_000, 'the third nginx -t');
      await publish();
      await publish();
      await publish();
      await sleep(500);
      for (let round = 0; round < 6; round += 1) {
        engine.release();
        await sleep(300);
      }
      assert.equal(tests(), 4, 'three requests in one reload are one more reload');
    } finally {
      reloader.kill('SIGTERM');
      await new Promise((done) => api.close(done));
      await engine.close();
      rmSync(directory, { recursive: true, force: true });
      await valkey.stop();
    }
  },
);

/**
 * P-20: the renderer stages a changed configuration and asks the reloader to
 * validate it in the running proxy before it becomes live. A Docker Engine
 * stand-in that answers every exec at once with the exit code the test sets,
 * or refuses to create one, as the Engine does for a stopped container.
 */
function answeringEngine(socketPath) {
  const state = { commands: [], exitCode: 0, createStatus: 201 };
  let next = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '';
      response.setHeader('content-type', 'application/json');
      if (/\/containers\/[^/]+\/exec$/u.test(url)) {
        state.commands.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).Cmd);
        if (state.createStatus !== 201) {
          response.writeHead(state.createStatus);
          response.end('{"message":"container is not running"}');
          return;
        }
        next += 1;
        response.writeHead(201);
        response.end(JSON.stringify({ Id: `exec${String(next)}` }));
        return;
      }
      response.writeHead(200);
      response.end(/\/start$/u.test(url) ? '' : JSON.stringify({ ExitCode: state.exitCode }));
    });
  });
  return {
    state,
    listen: () => new Promise((done) => server.listen(socketPath, done)),
    close: () => new Promise((done) => server.close(done)),
  };
}

test(
  'P-20: proxy-reloader validates a staged configuration and answers the renderer',
  { timeout: 120_000 },
  async () => {
    const valkey = await new GenericContainer('valkey/valkey:9.1-alpine')
      .withExposedPorts(6379)
      .start();
    const directory = mkdtempSync(join(tmpdir(), 'rr-validate-'));
    const engine = answeringEngine(join(directory, 'docker.sock'));
    await engine.listen();
    const reports = [];
    const api = createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        reports.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.setHeader('content-type', 'application/json');
        response.end('{"recorded":true}');
      });
    });
    await new Promise((done) => api.listen(0, '127.0.0.1', done));
    const valkeyUrl = `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}/0`;
    const reloader = spawn(
      'node',
      ['apps/api/dist/tools/proxy-reloader.js', '--profile', 'nginx'],
      {
        env: {
          ...process.env,
          VALKEY_URL: valkeyUrl,
          DOCKER_SOCKET: join(directory, 'docker.sock'),
          RR_PROXY_CONTAINER: 'proxy',
          INTERNAL_API_URL: `http://127.0.0.1:${String(api.address().port)}`,
          RR_INTERNAL_TOKEN: 'proxy-reloader-test',
        },
        stdio: 'pipe',
      },
    );
    const log = [];
    for (const stream of [reloader.stdout, reloader.stderr])
      stream.on('data', (chunk) => log.push(String(chunk)));
    // The renderer's side: ask, and read the answer from the reply channel.
    const answers = spawn(
      'docker',
      ['exec', '-i', valkey.getId(), 'valkey-cli', 'subscribe', 'rr:proxy.validated'],
      { stdio: 'pipe' },
    );
    const replies = [];
    answers.stdout.on('data', (chunk) => replies.push(String(chunk)));
    const verdict = async (id) => {
      await valkey.exec(['valkey-cli', 'publish', 'rr:proxy.validate', JSON.stringify({ id })]);
      await waitFor(() => replies.join('').includes(`"id":"${id}"`), 10_000, `the answer to ${id}`);
      // Without a terminal `valkey-cli` prints each message field on a line.
      const line = replies
        .join('')
        .split('\n')
        .find((entry) => entry.startsWith('{') && entry.includes(`"id":"${id}"`));
      return JSON.parse(line).verdict;
    };

    try {
      await waitFor(
        () => log.join('').includes('watching rr:proxy.reload'),
        30_000,
        'the reloader',
      );
      await waitFor(
        () => replies.join('').includes('rr:proxy.validated'),
        10_000,
        'the subscription',
      );

      assert.equal(await verdict('a'), 'ok');
      assert.deepEqual(engine.state.commands.at(-1), [
        'nginx',
        '-t',
        '-c',
        '/etc/nginx/conf.d/.staging/nginx.conf',
      ]);

      engine.state.exitCode = 1;
      assert.equal(await verdict('b'), 'invalid');
      // A refusal is recorded and raises `proxy.config_invalid`, as a refused
      // reload does.
      await waitFor(() => reports.some((report) => report.ok === false), 10_000, 'the report');

      engine.state.createStatus = 409;
      assert.equal(await verdict('c'), 'unavailable');
      assert.equal(reports.filter((report) => report.ok === false).length, 1);
    } finally {
      answers.kill('SIGTERM');
      reloader.kill('SIGTERM');
      await new Promise((done) => api.close(done));
      await engine.close();
      rmSync(directory, { recursive: true, force: true });
      await valkey.stop();
    }
  },
);
