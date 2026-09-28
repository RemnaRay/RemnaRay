/**
 * Section 17.1 p. 4 (R29): `RR_APP_KEY` encrypts every `is_secret` setting and
 * `*_enc` column (`v1:<nonce>:<ciphertext>:<tag>`, AES-256-GCM). Rotation
 * decrypts each with the old key and encrypts it with the new one. Everything
 * is read and re-encrypted before anything is written, and the caller runs it
 * in one transaction: a value the old key cannot read stops it with nothing
 * changed, so no database ever holds a mix of the two keys.
 */
import { Buffer } from 'node:buffer';

import { decryptSetting, encryptSetting } from '../modules/settings/settings.crypto';

export type RotationStore = {
  secretSettings(): Promise<{ key: string; value: unknown }[]>;
  setSetting(key: string, value: unknown): Promise<void>;
  providers(): Promise<{ code: string; configEnc: string | null }[]>;
  setProvider(code: string, configEnc: string): Promise<void>;
  admins(): Promise<{ id: string; totpSecretEnc: string | null }[]>;
  setAdmin(id: string, totpSecretEnc: string): Promise<void>;
  panels(): Promise<{ id: number; apiTokenEnc: string; webhookSecretEnc: string | null }[]>;
  setPanel(id: number, apiTokenEnc: string, webhookSecretEnc: string | null): Promise<void>;
};

export type RotationCounts = {
  settings: number;
  providers: number;
  admins: number;
  panels: number;
};

function isAppKey(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/u.test(value) && Buffer.from(value, 'base64').length === 32;
}

export async function rotateAppKey(
  store: RotationStore,
  oldKey: string,
  newKey: string,
): Promise<RotationCounts> {
  if (!isAppKey(oldKey)) throw new Error('The old key is not 32 bytes of base64');
  if (!isAppKey(newKey)) throw new Error('The new key is not 32 bytes of base64');
  if (oldKey === newKey) throw new Error('The old and the new key are the same');

  const unreadable: string[] = [];
  const again = (label: string, value: unknown): { enc: string } | undefined => {
    try {
      return encryptSetting(decryptSetting(value, oldKey), newKey);
    } catch {
      unreadable.push(label);
      return undefined;
    }
  };
  const column = (label: string, enc: string | null): string | null =>
    enc ? (again(label, { enc })?.enc ?? null) : null;

  const settings = (await store.secretSettings()).map((row) => ({
    key: row.key,
    value: again(`settings ${row.key}`, row.value),
  }));
  const providers = (await store.providers())
    .filter((row) => row.configEnc)
    .map((row) => ({ code: row.code, configEnc: column(`providers ${row.code}`, row.configEnc) }));
  const admins = (await store.admins())
    .filter((row) => row.totpSecretEnc)
    .map((row) => ({ id: row.id, totpSecretEnc: column(`admins ${row.id}`, row.totpSecretEnc) }));
  const panels = (await store.panels())
    .filter((row) => row.apiTokenEnc || row.webhookSecretEnc)
    .map((row) => ({
      id: row.id,
      apiTokenEnc: row.apiTokenEnc
        ? (column(`panels ${String(row.id)}`, row.apiTokenEnc) ?? '')
        : '',
      webhookSecretEnc: column(`panels ${String(row.id)} webhook`, row.webhookSecretEnc),
    }));

  if (unreadable.length > 0)
    throw new Error(`The old key does not decrypt ${unreadable.join(', ')}; nothing was changed`);

  for (const row of settings) await store.setSetting(row.key, row.value);
  for (const row of providers) if (row.configEnc) await store.setProvider(row.code, row.configEnc);
  for (const row of admins) if (row.totpSecretEnc) await store.setAdmin(row.id, row.totpSecretEnc);
  for (const row of panels) await store.setPanel(row.id, row.apiTokenEnc, row.webhookSecretEnc);
  return {
    settings: settings.length,
    providers: providers.length,
    admins: admins.length,
    panels: panels.length,
  };
}
