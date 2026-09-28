import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

const IMAGE = 'remnaray/backup:test';
const SCRIPTS = resolve(process.cwd(), 'deploy/backup');

function docker(args, { expectSuccess = true } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (expectSuccess && result.status !== 0)
    throw new Error(`docker ${args.join(' ')} failed with ${String(result.status)}:\n${output}`);
  return output;
}

/** Runs the entrypoint against the host network so it reaches the container. */
function backup(subcommand, directory, environment = []) {
  const variables = environment.flatMap((entry) => ['-e', entry]);
  return docker([
    'run',
    '--rm',
    '--network',
    'host',
    '-v',
    `${SCRIPTS}:/scripts:ro`,
    '-v',
    `${directory}:/backups`,
    ...variables,
    IMAGE,
    subcommand,
  ]);
}

test(
  'TASK-M5-006 / AC-202: a dump is written and the 14/8 retention holds',
  { timeout: 600_000 },
  async () => {
    docker(['build', '-f', 'deploy/backup/Dockerfile', '-t', IMAGE, '.']);

    const postgres = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('remnaray')
      .withUsername('remnaray')
      .withPassword('remnaray')
      .start();
    const directory = mkdtempSync(join(tmpdir(), 'rr-backups-'));

    try {
      execFileSync('pnpm', ['--filter', '@remnaray/db', 'db:migrate:deploy'], {
        env: { ...process.env, DATABASE_URL: postgres.getConnectionUri() },
        stdio: 'pipe',
      });

      // --- a dump is created (AC-202, first half) ---
      const environment = [
        `POSTGRES_HOST=${postgres.getHost()}`,
        `PGPORT=${String(postgres.getMappedPort(5432))}`,
        'POSTGRES_USER=remnaray',
        'POSTGRES_DB=remnaray',
        'POSTGRES_PASSWORD=remnaray',
      ];
      backup('once', directory, environment);

      const dumps = readdirSync(directory).filter((name) => /^remnaray-\d/u.test(name));
      assert.equal(dumps.length, 1, `expected one dump, got ${dumps.join(', ')}`);
      const dump = join(directory, dumps[0]);
      assert.ok(readFileSync(dump).length > 1000, 'the dump must not be empty');

      // R110: the dump holds every secret the database has (password hashes,
      // TOTP secrets, ciphertexts); it was 0644 root, readable by every user
      // of the host. Now 0600 and the backups directory owner's — whoever
      // restores from the host can read it, nobody else — in a directory
      // others may only pass through to the status file.
      const mode = (path) => statSync(path).mode & 0o777;
      assert.equal(mode(dump), 0o600, 'the dump is readable by others');
      assert.equal(statSync(dump).uid, statSync(directory).uid);
      assert.equal(mode(directory), 0o711);
      assert.equal(mode(join(directory, '.last-status')), 0o644);

      const status = readFileSync(join(directory, '.last-status'), 'utf8').trim().split(/\s+/u);
      assert.equal(status[0], 'ok');
      assert.equal(status[2], dumps[0]);
      assert.ok(Number(status[3]) > 1000, 'the status must carry the size');

      // The restore of section 20.5 reads it back into a clean database.
      const restored = docker(
        [
          'run',
          '--rm',
          '--network',
          'host',
          '-v',
          `${directory}:/backups`,
          '-e',
          'PGPASSWORD=remnaray',
          'postgres:18-alpine',
          'pg_restore',
          '--host',
          postgres.getHost(),
          '--port',
          String(postgres.getMappedPort(5432)),
          '--username',
          'remnaray',
          '--dbname',
          'remnaray',
          '--clean',
          '--if-exists',
          `/backups/${dumps[0]}`,
        ],
        { expectSuccess: false },
      );
      assert.ok(!/error:/iu.test(restored.replace(/^.*does not exist.*$/gmu, '')), restored);

      const tables = execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'host',
          '-e',
          'PGPASSWORD=remnaray',
          'postgres:18-alpine',
          'psql',
          '--host',
          postgres.getHost(),
          '--port',
          String(postgres.getMappedPort(5432)),
          '--username',
          'remnaray',
          '--dbname',
          'remnaray',
          '-tAc',
          "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
        ],
        { encoding: 'utf8' },
      ).trim();
      assert.ok(Number(tables) > 20, `expected the schema back, saw ${tables} tables`);

      // --- rotation keeps 14 daily and 8 weekly (AC-202, second half) ---
      for (let day = 1; day <= 30; day += 1) {
        const stamp = `202601${String(day).padStart(2, '0')}-0300`;
        writeFileSync(join(directory, `remnaray-${stamp}.dump`), 'x');
        writeFileSync(join(directory, `files-${stamp}.tar.gz`), 'x');
      }
      for (let week = 1; week <= 12; week += 1)
        writeFileSync(
          join(directory, `remnaray-weekly-2026${String(week).padStart(4, '0')}-0300.dump`),
          'x',
        );

      backup('rotate', directory);

      const remaining = readdirSync(directory);
      assert.equal(remaining.filter((name) => /^remnaray-\d/u.test(name)).length, 14);
      assert.equal(remaining.filter((name) => name.startsWith('remnaray-weekly-')).length, 8);
      assert.equal(remaining.filter((name) => name.startsWith('files-')).length, 14);

      // The newest survive and the oldest go: the real dump taken above is the
      // most recent of all, and the first fixtures are gone.
      const daily = remaining.filter((name) => /^remnaray-\d/u.test(name)).sort();
      assert.equal(daily.at(-1), dumps[0], `kept the newest: ${daily.join(', ')}`);
      assert.ok(daily.includes('remnaray-20260130-0300.dump'), daily.join(', '));
      assert.ok(!daily.includes('remnaray-20260101-0300.dump'), daily.join(', '));
      assert.ok(!daily.includes('remnaray-20260117-0300.dump'), daily.join(', '));
      process.stdout.write(`backup rotation kept ${String(daily.length)} daily and 8 weekly\n`);
    } finally {
      await postgres.stop();
    }
  },
);

/**
 * Section 20.5 and 26.4 R3 through `deploy/backup/restore.sh` itself, on a
 * compose project of its own: a database user and name other than the
 * defaults, which only compose knows (the operator's shell never reads
 * `.env`), and the themes and uploads archive the backup takes with the dump.
 */
test(
  '26.4 R3: restore.sh brings back the database, themes and uploads with a custom user',
  { timeout: 600_000 },
  async () => {
    docker(['build', '-f', 'deploy/backup/Dockerfile', '-t', IMAGE, '.']);
    const directory = mkdtempSync(join(tmpdir(), 'rr-restore-'));
    const project = `rrrestore${String(process.pid)}`;
    const composeFile = join(directory, 'compose.yaml');
    writeFileSync(
      composeFile,
      `name: ${project}
services:
  # No named data volume: after a down the database starts empty, as 26.4 R3
  # has it after removing remnaray_pgdata.
  postgres:
    image: postgres:18-alpine
    environment: { POSTGRES_USER: shop_owner, POSTGRES_PASSWORD: secret, POSTGRES_DB: shopdb }
    healthcheck:
      test: [CMD-SHELL, 'pg_isready -U shop_owner -d shopdb']
      interval: 1s
      retries: 60
  backup:
    image: ${IMAGE}
    environment:
      { POSTGRES_HOST: postgres, POSTGRES_USER: shop_owner, POSTGRES_PASSWORD: secret, POSTGRES_DB: shopdb }
    volumes:
      - ./backups:/backups
      - ${SCRIPTS}:/scripts:ro
      - ./themes:/src/themes:ro
      - uploads:/src/uploads:ro
    depends_on: { postgres: { condition: service_healthy } }
    profiles: [nginx]
volumes:
  uploads: {}
`,
    );
    const compose = (...args) => docker(['compose', '-f', composeFile, ...args]);
    const sql = (statement) =>
      compose(
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'shop_owner',
        '-d',
        'shopdb',
        '-tAc',
        statement,
      ).trim();
    // Standard output only: compose reports the one-off container on stderr.
    const upload = (command) =>
      execFileSync(
        'docker',
        ['compose', '-f', composeFile, 'run', '--rm', '-T', '--no-deps', '-v', 'uploads:/u'].concat(
          ['--entrypoint', 'sh', 'backup', '-c', command],
        ),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
    // The operator's shell: no database variables, as on a server.
    const shell = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !['POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD'].includes(name),
      ),
    );
    try {
      execFileSync('mkdir', ['-p', join(directory, 'themes/manta'), join(directory, 'backups')]);
      writeFileSync(join(directory, 'themes/manta/theme.json'), '{"v":1}');
      compose('--profile', 'nginx', 'up', '-d', '--wait');
      sql("CREATE TABLE marks (v text); INSERT INTO marks VALUES ('backed-up')");
      upload('echo logo-v1 > /u/logo.txt');

      // R1: the backup, with its files archive.
      compose('exec', '-T', 'backup', '/bin/sh', '/scripts/backup-entrypoint.sh', 'once');
      const dump = readdirSync(join(directory, 'backups')).find((name) =>
        /^remnaray-\d/u.test(name),
      );
      assert.ok(dump, 'no dump was written');
      const stamp = dump.replace(/^remnaray-/u, '').replace(/\.dump$/u, '');
      assert.ok(readdirSync(join(directory, 'backups')).includes(`files-${stamp}.tar.gz`));
      // R110: the archive of themes and uploads is private too.
      assert.equal(
        statSync(join(directory, 'backups', `files-${stamp}.tar.gz`)).mode & 0o777,
        0o600,
      );

      // R2: what happens after the backup.
      sql("INSERT INTO marks VALUES ('after')");
      writeFileSync(join(directory, 'themes/manta/theme.json'), '{"v":2}');
      upload('echo logo-v2 > /u/logo.txt');

      // R3: the restore, confirmed up front as an unattended run would be.
      const restore = spawnSync(
        'sh',
        ['deploy/backup/restore.sh', join(directory, 'backups', dump)],
        {
          env: {
            ...shell,
            COMPOSE_FILE: composeFile,
            RR_PROXY_PROFILE: 'nginx',
            RR_RESTORE_ASSUME_YES: 'true',
          },
          encoding: 'utf8',
        },
      );
      assert.equal(restore.status, 0, `${restore.stdout}${restore.stderr}`);

      assert.equal(sql("SELECT string_agg(v, ',') FROM marks"), 'backed-up');
      assert.equal(readFileSync(join(directory, 'themes/manta/theme.json'), 'utf8'), '{"v":1}');
      assert.equal(upload('cat /u/logo.txt'), 'logo-v1');
    } finally {
      docker(['compose', '-f', composeFile, '--profile', 'nginx', 'down', '-v'], {
        expectSuccess: false,
      });
    }
  },
);

/**
 * P-4: the rollback of section 20.6 and a daily dump restored after an
 * upgrade both put an older schema back. `pg_restore --clean --if-exists`
 * into the live database could not drop a table a newer one references
 * (0010's `support_tickets.user_id → users`): the restore failed half-way,
 * left the newer rows and tables beside the older `_prisma_migrations`, and
 * stopped with the stack down. The dump now goes into a fresh database that
 * replaces the old one only when the whole restore succeeded.
 */
test(
  'P-4: restore.sh puts back a dump older than the current schema',
  { timeout: 600_000 },
  async () => {
    docker(['build', '-f', 'deploy/backup/Dockerfile', '-t', IMAGE, '.']);
    const directory = mkdtempSync(join(tmpdir(), 'rr-restore-older-'));
    const project = `rrolder${String(process.pid)}`;
    const composeFile = join(directory, 'compose.yaml');
    writeFileSync(
      composeFile,
      `name: ${project}
services:
  # A named data volume, as the deployment has: the database the dump
  # replaces is still there when the restore runs.
  postgres:
    image: postgres:18-alpine
    environment: { POSTGRES_USER: shop_owner, POSTGRES_PASSWORD: secret, POSTGRES_DB: shopdb }
    volumes: [pgdata:/var/lib/postgresql]
    healthcheck:
      test: [CMD-SHELL, 'pg_isready -h 127.0.0.1 -U shop_owner -d shopdb']
      interval: 1s
      retries: 60
  backup:
    image: ${IMAGE}
    environment:
      { POSTGRES_HOST: postgres, POSTGRES_USER: shop_owner, POSTGRES_PASSWORD: secret, POSTGRES_DB: shopdb }
    volumes:
      - ./backups:/backups
      - ${SCRIPTS}:/scripts:ro
    depends_on: { postgres: { condition: service_healthy } }
    profiles: [nginx]
volumes:
  pgdata: {}
`,
    );
    const compose = (...args) => docker(['compose', '-f', composeFile, ...args]);
    const sql = (statement) =>
      compose(
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'shop_owner',
        '-d',
        'shopdb',
        '-tAc',
        statement,
      ).trim();
    const shell = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !['POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD'].includes(name),
      ),
    );
    try {
      execFileSync('mkdir', ['-p', join(directory, 'backups')]);
      compose('--profile', 'nginx', 'up', '-d', '--wait');
      sql(
        "CREATE TABLE users (id int PRIMARY KEY, name text); INSERT INTO users VALUES (1, 'before')",
      );
      compose('exec', '-T', 'backup', '/bin/sh', '/scripts/backup-entrypoint.sh', 'once');
      const dump = readdirSync(join(directory, 'backups')).find((name) =>
        /^remnaray-\d.*\.dump$/u.test(name),
      );
      assert.ok(dump, 'no dump was written');

      // The upgrade: a new table that references an old one, and new rows.
      sql(
        'CREATE TABLE support_tickets (id int PRIMARY KEY, user_id int NOT NULL REFERENCES users (id));' +
          " INSERT INTO users VALUES (2, 'after'); INSERT INTO support_tickets VALUES (1, 2)",
      );

      const restoreFrom = (file) =>
        spawnSync('sh', ['deploy/backup/restore.sh', file], {
          env: {
            ...shell,
            COMPOSE_FILE: composeFile,
            RR_PROXY_PROFILE: 'nginx',
            RR_RESTORE_ASSUME_YES: 'true',
          },
          encoding: 'utf8',
        });

      // A dump cut short fails, and the current database is left as it was.
      const whole = readFileSync(join(directory, 'backups', dump));
      const broken = join(directory, 'backups', 'remnaray-broken.dump');
      writeFileSync(broken, whole.subarray(0, Math.floor(whole.length / 2)));
      const failed = restoreFrom(broken);
      assert.notEqual(failed.status, 0, `${failed.stdout}${failed.stderr}`);
      assert.match(failed.stderr, /the current database is unchanged/u);
      assert.equal(sql("SELECT string_agg(name, ',' ORDER BY id) FROM users"), 'before,after');

      const restore = restoreFrom(join(directory, 'backups', dump));
      assert.equal(restore.status, 0, `${restore.stdout}${restore.stderr}`);
      assert.equal(sql("SELECT string_agg(name, ',' ORDER BY id) FROM users"), 'before');
      assert.equal(
        sql(
          "SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'public'",
        ),
        'users',
      );
      // Nothing is left of the database the restore went into.
      assert.equal(sql("SELECT count(*) FROM pg_database WHERE datname LIKE 'shopdb%'"), '1');
    } finally {
      docker(['compose', '-f', composeFile, '--profile', 'nginx', 'down', '-v'], {
        expectSuccess: false,
      });
    }
  },
);

/**
 * R60: `migrate` runs as uid 1000 and writes the pre-migrate dump under
 * `./backups`, which a clone made as root (`sudo git clone`, the usual VPS)
 * leaves `root:root 0755`: `pg_dump` got `Permission denied`, `migrate`
 * exited 1 and nothing behind it started — exactly at an upgrade with an
 * irreversible migration. The `backup` service, which runs as root, prepares
 * `backups/pre-migrate` for uid 1000 and is healthy only once it has; the
 * deployment's own compose file is used, from a directory owned by root.
 */
test(
  'R60: migrate can write its pre-migrate dump into a root-owned ./backups',
  { timeout: 600_000 },
  async () => {
    docker(['build', '-f', 'deploy/backup/Dockerfile', '-t', IMAGE, '.']);
    const directory = mkdtempSync(join(tmpdir(), 'rr-backups-owner-'));
    const project = `rrowner${String(process.pid)}`;
    const compose = (...args) =>
      docker(['compose', '-p', project, '--project-directory', directory, ...args]);
    try {
      cpSync('compose.yaml', join(directory, 'compose.yaml'));
      cpSync('deploy', join(directory, 'deploy'), { recursive: true });
      writeFileSync(
        join(directory, '.env'),
        `${readFileSync('.env.example', 'utf8')}\nPOSTGRES_PASSWORD=secret\nRR_BACKUP_IMAGE=${IMAGE}\n`,
      );
      // `./backups` as a root clone leaves it.
      docker([
        'run',
        '--rm',
        '-v',
        `${directory}:/deployment`,
        '--entrypoint',
        'sh',
        IMAGE,
        '-c',
        'mkdir -p /deployment/backups && chown 0:0 /deployment/backups && chmod 755 /deployment/backups',
      ]);

      const config = JSON.parse(compose('config', '--format', 'json').replace(/^[^{]*/u, ''));
      const migrate = config.services.migrate;
      assert.equal(migrate.depends_on.backup?.condition, 'service_healthy');
      // Only a deployment profile starts `backup`; without one it is skipped.
      assert.equal(migrate.depends_on.backup.required, false);
      const target = migrate.environment.RR_BACKUP_DIR;
      assert.ok(target?.startsWith('/backups/'), `migrate writes into ${String(target)}`);

      compose('--profile', 'nginx', 'up', '-d', '--wait', 'backup');
      // What `migrate` does, as the user it runs as, on the same mount.
      const write = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--user',
          '1000:1000',
          '-v',
          `${join(directory, 'backups')}:/backups`,
          '--entrypoint',
          'sh',
          IMAGE,
          '-c',
          `touch ${target}/probe.dump`,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(write.status, 0, write.stderr);
    } finally {
      docker(
        [
          'compose',
          '-p',
          project,
          '--project-directory',
          directory,
          '--profile',
          'nginx',
          'down',
          '-v',
        ],
        {
          expectSuccess: false,
        },
      );
      docker(
        [
          'run',
          '--rm',
          '-v',
          `${directory}:/deployment`,
          '--entrypoint',
          'rm',
          IMAGE,
          '-rf',
          '/deployment/backups',
        ],
        {
          expectSuccess: false,
        },
      );
    }
  },
);

/**
 * The optional S3 copy of section 20.5, against a real S3 server (SeaweedFS,
 * which checks the signature) with the image's own `mcli`. A wrapper ahead of
 * it on the PATH records every command line, as `ps` on the host shows it.
 */
function s3Project(name) {
  const directory = mkdtempSync(join(tmpdir(), `rr-${name}-`));
  const project = `rr${name}${String(process.pid)}`;
  const composeFile = join(directory, 'compose.yaml');
  const secret = 'rr/Secret+x9';
  execFileSync('mkdir', [
    '-p',
    join(directory, 'backups'),
    join(directory, 'wrap'),
    join(directory, 'themes'),
  ]);
  writeFileSync(
    join(directory, 's3.json'),
    JSON.stringify({
      identities: [
        {
          name: 'rr',
          credentials: [{ accessKey: 'rrkey', secretKey: secret }],
          actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
        },
      ],
    }),
  );
  writeFileSync(
    join(directory, 'wrap', 'mcli'),
    '#!/bin/sh\n(umask 022; printf "%s\\n" "$*" >> /argv/log)\nexec /usr/bin/mcli "$@"\n',
    { mode: 0o755 },
  );
  writeFileSync(join(directory, 'themes', 'theme.json'), '{"v":1}');
  writeFileSync(
    composeFile,
    `name: ${project}
services:
  postgres:
    image: postgres:18-alpine
    environment: { POSTGRES_USER: remnaray, POSTGRES_PASSWORD: secret, POSTGRES_DB: remnaray }
    healthcheck:
      test: [CMD-SHELL, 'pg_isready -h 127.0.0.1 -U remnaray -d remnaray']
      interval: 1s
      retries: 60
  s3:
    image: chrislusf/seaweedfs
    command: [server, -s3, -s3.config=/etc/s3.json, -dir=/data]
    volumes: [./s3.json:/etc/s3.json:ro]
  backup:
    image: ${IMAGE}
    environment:
      POSTGRES_HOST: postgres
      POSTGRES_USER: remnaray
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: remnaray
      RR_BACKUP_S3_ENDPOINT: http://s3:8333
      RR_BACKUP_S3_BUCKET: backups
      RR_BACKUP_S3_PREFIX: shop
      RR_BACKUP_S3_ACCESS_KEY: rrkey
      RR_BACKUP_S3_SECRET_KEY: '${secret}'
      PATH: /wrap:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    volumes:
      - ./backups:/backups
      - ${SCRIPTS}:/scripts:ro
      - ./wrap:/wrap:ro
      - ./argv:/argv
      - ./themes:/src/themes:ro
    depends_on: { postgres: { condition: service_healthy } }
`,
  );
  const compose = (...args) => docker(['compose', '-f', composeFile, ...args]);
  // Straight to the server, with the credentials the test knows.
  const s3 = (...args) =>
    spawnSync(
      'docker',
      [
        'compose',
        '-f',
        composeFile,
        'run',
        '--rm',
        '-T',
        '--no-deps',
        '-e',
        `MC_HOST_s3=http://rrkey:${secret}@s3:8333`,
      ].concat(['--entrypoint', '/usr/bin/mcli', 'backup', ...args]),
      { encoding: 'utf8' },
    );
  const start = async () => {
    compose('up', '-d', '--wait', 'postgres');
    compose('up', '-d', 's3');
    for (let attempt = 0; ; attempt += 1) {
      const made = s3('mb', '--ignore-existing', 's3/backups');
      if (made.status === 0) break;
      if (attempt > 60) throw new Error(`the S3 server never answered: ${made.stderr}`);
      await sleep(1000);
    }
  };
  const once = () =>
    spawnSync('docker', ['compose', '-f', composeFile, 'run', '--rm', '-T', 'backup', 'once'], {
      encoding: 'utf8',
    });
  const cleanup = () => {
    docker(['compose', '-f', composeFile, 'down', '-v'], { expectSuccess: false });
    docker(
      [
        'run',
        '--rm',
        '-v',
        `${directory}:/d`,
        '--entrypoint',
        'rm',
        IMAGE,
        '-rf',
        '/d/backups',
        '/d/argv',
      ],
      {
        expectSuccess: false,
      },
    );
  };
  return { directory, secret, compose, s3, start, once, cleanup };
}

// R111: `mcli alias set rr <endpoint> <access> <secret>` put the S3 keys on
// the command line of a process every user of the host sees in `ps`.
test('R111: the S3 copy never puts the keys on a command line', { timeout: 600_000 }, async () => {
  docker(['build', '-f', 'deploy/backup/Dockerfile', '-t', IMAGE, '.']);
  const project = s3Project('s3argv');
  try {
    await project.start();
    const result = project.once();
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const listing = project.s3('ls', 's3/backups/shop/');
    assert.match(listing.stdout, /remnaray-\d{8}-\d{4}\.dump/u, listing.stdout + listing.stderr);
    const argv = readFileSync(join(project.directory, 'argv', 'log'), 'utf8');
    assert.ok(argv.trim().length > 0, 'mcli was never run');
    assert.ok(!argv.includes(project.secret), argv);
    assert.ok(!argv.includes('rrkey'), argv);
  } finally {
    project.cleanup();
  }
});
