/**
 * `pnpm rr:rotate-key --old <key> --new <key>` (section 17.1 p. 4, R29), or
 * with the keys in `RR_OLD_APP_KEY` and `RR_NEW_APP_KEY`, which is how
 * `./scripts/rr rotate-key` runs it: a key on a command line is visible to
 * every user of the host in `ps`. Stop `api`, `worker` and `bot` first, and
 * put the new key in `.env` before starting them again.
 */
import process from 'node:process';
import { createPrismaClient } from '@remnaray/db';
import type { Prisma } from '@remnaray/db';

import { rotateAppKey, type RotationStore } from './key-rotation';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function store(tx: Prisma.TransactionClient): RotationStore {
  return {
    secretSettings: () =>
      tx.setting.findMany({ where: { isSecret: true }, select: { key: true, value: true } }),
    setSetting: async (key, value) => {
      await tx.setting.update({ where: { key }, data: { value: value as Prisma.InputJsonValue } });
    },
    providers: () => tx.paymentProvider.findMany({ select: { code: true, configEnc: true } }),
    setProvider: async (code, configEnc) => {
      await tx.paymentProvider.update({ where: { code }, data: { configEnc } });
    },
    admins: () => tx.admin.findMany({ select: { id: true, totpSecretEnc: true } }),
    setAdmin: async (id, totpSecretEnc) => {
      await tx.admin.update({ where: { id }, data: { totpSecretEnc } });
    },
    panels: () =>
      tx.panel.findMany({ select: { id: true, apiTokenEnc: true, webhookSecretEnc: true } }),
    setPanel: async (id, apiTokenEnc, webhookSecretEnc) => {
      await tx.panel.update({ where: { id }, data: { apiTokenEnc, webhookSecretEnc } });
    },
  };
}

async function main(): Promise<void> {
  const oldKey = flag('old') ?? process.env.RR_OLD_APP_KEY ?? '';
  const newKey = flag('new') ?? process.env.RR_NEW_APP_KEY ?? '';
  const db = createPrismaClient();
  try {
    const counts = await db.$transaction((tx) => rotateAppKey(store(tx), oldKey, newKey), {
      timeout: 120_000,
    });
    process.stdout.write(
      `Re-encrypted ${String(counts.settings)} settings, ${String(counts.providers)} providers, ` +
        `${String(counts.admins)} admins and ${String(counts.panels)} panels. ` +
        'Put the new key in .env as RR_APP_KEY, then start the stack.\n',
    );
  } catch (error) {
    process.stderr.write(`rotate-key: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

void main();
