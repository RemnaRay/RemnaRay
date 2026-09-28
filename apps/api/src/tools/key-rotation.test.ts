import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { decryptSetting, encryptSetting } from '../modules/settings/settings.crypto';
import { rotateAppKey, type RotationStore } from './key-rotation';

const oldKey = randomBytes(32).toString('base64');
const newKey = randomBytes(32).toString('base64');
const enc = (value: unknown, key = oldKey) => encryptSetting(value, key).enc;

/** The four places section 17.1 p. 4 names, in memory. */
function store() {
  const rows = {
    settings: [
      { key: 'bot.token', value: { enc: enc('123:abc') } as unknown, isSecret: true },
      { key: 'shop.name', value: 'Shop' as unknown, isSecret: false },
    ],
    providers: [
      { code: 'yookassa', configEnc: enc({ secretKey: 'live' }) as string | null },
      { code: 'mock', configEnc: null as string | null },
    ],
    admins: [{ id: 'a1', totpSecretEnc: enc('JBSWY3DP') as string | null }],
    panels: [{ id: 1, apiTokenEnc: enc('panel'), webhookSecretEnc: null as string | null }],
  };
  const writes: string[] = [];
  const target: RotationStore = {
    secretSettings: () => Promise.resolve(rows.settings.filter((row) => row.isSecret)),
    setSetting: (key, value) => {
      writes.push(`setting ${key}`);
      const row = rows.settings.find((item) => item.key === key);
      if (row) row.value = value;
      return Promise.resolve();
    },
    providers: () => Promise.resolve(rows.providers),
    setProvider: (code, configEnc) => {
      writes.push(`provider ${code}`);
      const row = rows.providers.find((item) => item.code === code);
      if (row) row.configEnc = configEnc;
      return Promise.resolve();
    },
    admins: () => Promise.resolve(rows.admins),
    setAdmin: (id, totpSecretEnc) => {
      writes.push(`admin ${id}`);
      const row = rows.admins.find((item) => item.id === id);
      if (row) row.totpSecretEnc = totpSecretEnc;
      return Promise.resolve();
    },
    panels: () => Promise.resolve(rows.panels),
    setPanel: (id, apiTokenEnc, webhookSecretEnc) => {
      writes.push(`panel ${String(id)}`);
      const row = rows.panels.find((item) => item.id === id);
      if (row) Object.assign(row, { apiTokenEnc, webhookSecretEnc });
      return Promise.resolve();
    },
  };
  return { rows, writes, target };
}

describe('RR_APP_KEY rotation (section 17.1 p. 4, R29)', () => {
  it('re-encrypts every secret setting and *_enc column with the new key', async () => {
    const { rows, target } = store();
    expect(await rotateAppKey(target, oldKey, newKey)).toEqual({
      settings: 1,
      providers: 1,
      admins: 1,
      panels: 1,
    });
    expect(decryptSetting(rows.settings[0]?.value, newKey)).toBe('123:abc');
    expect(rows.settings[1]?.value).toBe('Shop');
    expect(decryptSetting({ enc: rows.providers[0]?.configEnc }, newKey)).toEqual({
      secretKey: 'live',
    });
    expect(rows.providers[1]?.configEnc).toBeNull();
    expect(decryptSetting({ enc: rows.admins[0]?.totpSecretEnc }, newKey)).toBe('JBSWY3DP');
    expect(decryptSetting({ enc: rows.panels[0]?.apiTokenEnc }, newKey)).toBe('panel');
    expect(() => decryptSetting(rows.settings[0]?.value, oldKey)).toThrow();
  });

  it('changes nothing when a value does not decrypt with the old key', async () => {
    const { rows, writes, target } = store();
    rows.admins.push({ id: 'a2', totpSecretEnc: enc('OTHER', randomBytes(32).toString('base64')) });
    await expect(rotateAppKey(target, oldKey, newKey)).rejects.toThrow(/admins a2/u);
    expect(writes).toEqual([]);
  });

  it('refuses keys that are not 32 bytes of base64, or the same key twice', async () => {
    const { target } = store();
    await expect(rotateAppKey(target, 'short', newKey)).rejects.toThrow(/old key/u);
    await expect(rotateAppKey(target, oldKey, 'short')).rejects.toThrow(/new key/u);
    await expect(rotateAppKey(target, oldKey, oldKey)).rejects.toThrow(/same/u);
  });
});
