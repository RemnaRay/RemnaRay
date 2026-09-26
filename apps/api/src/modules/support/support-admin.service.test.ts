import { describe, expect, it, vi } from 'vitest';

import { SupportAdminService } from './support-admin.service';

function service() {
  const rows = new Map<string, Record<string, unknown>>();
  const id = '00000000-0000-4000-8000-000000000001';
  const db = {
    supportTemplate: {
      findMany: vi.fn(() => Promise.resolve([...rows.values()])),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(rows.get(where.id) ?? null),
      ),
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        if ([...rows.values()].some((row) => row['code'] === data['code']))
          return Promise.reject(Object.assign(new Error('unique'), { code: 'P2002' }));
        const row = { id, ...data };
        rows.set(id, row);
        return Promise.resolve(row);
      }),
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = { ...rows.get(where.id), ...data };
        rows.set(where.id, row);
        return Promise.resolve(row);
      }),
      delete: vi.fn(({ where }: { where: { id: string } }) => {
        rows.delete(where.id);
        return Promise.resolve({});
      }),
    },
  };
  return { instance: new SupportAdminService({ db } as never), id };
}

describe('support templates in the console (F36)', () => {
  const body = { code: 'link', title: 'Connect', body: { ru: 'Ссылка', en: 'Link' } };

  it('creates, lists, edits and deletes a template, auditing both sides', async () => {
    const { instance, id } = service();
    const created = await instance.createTemplate(body);
    expect(created.before).toBeNull();
    expect(created.after).toMatchObject({ id, code: 'link', sortOrder: 100 });
    await expect(instance.templates()).resolves.toMatchObject({ items: [{ code: 'link' }] });

    const updated = await instance.updateTemplate(id, { ...body, title: 'How to connect' });
    expect(updated.before).toMatchObject({ title: 'Connect' });
    expect(updated.after).toMatchObject({ title: 'How to connect' });

    const deleted = await instance.deleteTemplate(id);
    expect(deleted.body).toEqual({ deleted: true });
    await expect(instance.templates()).resolves.toEqual({ items: [] });
  });

  it('refuses a duplicate code, a bad code, an empty text and an unknown id', async () => {
    const { instance } = service();
    await instance.createTemplate(body);
    await expect(instance.createTemplate(body)).rejects.toMatchObject({
      response: { error: { code: 'CONFLICT' } },
    });
    await expect(instance.createTemplate({ ...body, code: 'Has Space' })).rejects.toThrow();
    await expect(
      instance.createTemplate({ ...body, code: 'empty', body: { ru: ' ', en: '' } }),
    ).rejects.toThrow();
    await expect(instance.deleteTemplate('not-a-uuid')).rejects.toMatchObject({ status: 404 });
  });
});
