import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/support',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const { renderPage } = await import('../test-utils/render-page');
const SupportClient = (await import('../app/admin/support/support-client')).default;
const { StatsTab, duration } = await import('../app/admin/support/stats-tab');
const { TemplatesTab } = await import('../app/admin/support/templates-tab');
const { FaqTab } = await import('../app/admin/support/faq-tab');

function me(permissions: string[]) {
  return {
    body: {
      admin: { id: 'a1', email: 'o@example.test', role: 'operator', telegramId: null, permissions },
      csrfToken: 'csrf',
    },
  };
}

const ticket = {
  id: '00000000-0000-4000-8000-000000000001',
  number: 128,
  status: 'in_progress',
  channel: 'support',
  openedBy: 'customer',
  assignee: { telegramId: '7', name: 'Olga' },
  createdAt: '2026-09-27T10:00:00.000Z',
  takenAt: '2026-09-27T10:05:00.000Z',
  firstResponseAt: '2026-09-27T10:05:00.000Z',
  closedAt: null,
  closedBy: null,
  closedSilently: false,
  rating: 4,
  user: { id: 'u1', telegramId: '42', username: 'anna', firstName: 'Anna' },
};

describe('the console’s support section (F36)', () => {
  it('lists the tickets with status, customer, operator and rating', async () => {
    const markup = await renderPage(SupportClient, {
      '/api/admin/v1/auth/me': me(['support.read']),
      '/api/admin/v1/support/tickets': { body: { items: [ticket], nextCursor: null } },
    });
    expect(markup).toContain('Поддержка');
    expect(markup).toContain('#128');
    expect(markup).toContain('В работе');
    expect(markup).toContain('Anna @anna');
    expect(markup).toContain('href="/admin/users/u1"');
    expect(markup).toContain('Olga');
    expect(markup).toContain('★4');
  });

  it('shows the period’s numbers and each operator', async () => {
    const markup = await renderPage(StatsTab, {
      '/api/admin/v1/support/stats': {
        body: {
          from: '2026-08-28T00:00:00.000Z',
          to: '2026-09-27T00:00:00.000Z',
          opened: 12,
          closed: 10,
          openNow: 2,
          firstResponseSeconds: { average: 1260, median: 600 },
          resolutionSeconds: 7500,
          rating: { average: 4.5, count: 8 },
          operators: [
            {
              telegramId: '7',
              name: 'Olga',
              closed: 10,
              openNow: 2,
              firstResponseSeconds: 1260,
              rating: { average: 4.5, count: 8 },
            },
          ],
        },
      },
    });
    expect(markup).toContain('21 мин');
    expect(markup).toContain('10 мин');
    expect(markup).toContain('2 ч 5 мин');
    expect(markup).toContain('★4.50 (8)');
    expect(markup).toContain('Olga');
  });

  it('lets only support.write edit templates and questions', async () => {
    const routes = {
      '/api/admin/v1/support/templates': {
        body: {
          items: [
            {
              id: 't1',
              code: 'link',
              title: 'Как подключиться',
              body: { ru: 'Откройте', en: 'Open' },
              sortOrder: 100,
            },
          ],
        },
      },
      '/api/admin/v1/support/faq': {
        body: {
          items: [
            {
              id: 'f1',
              question: { ru: 'Нет сети?', en: '' },
              answer: { ru: 'Обновите', en: '' },
              sortOrder: 100,
              enabled: false,
            },
          ],
        },
      },
    };
    const props = { fail: () => undefined, notify: () => undefined };
    const readOnly = await renderPage(() => <TemplatesTab canWrite={false} {...props} />, routes);
    expect(readOnly).toContain('/t link');
    expect(readOnly).not.toContain('Новый шаблон');
    const editable = await renderPage(() => <TemplatesTab canWrite {...props} />, routes);
    expect(editable).toContain('Новый шаблон');

    const faq = await renderPage(() => <FaqTab canWrite {...props} />, routes);
    expect(faq).toContain('Нет сети?');
    expect(faq).toContain('Показать');
    expect(faq).toContain('Новый вопрос');
  });

  it('writes durations briefly', () => {
    const units = { h: 'ч', m: 'мин', s: 'с' };
    expect(duration(null, units)).toBe('—');
    expect(duration(45, units)).toBe('45 с');
    expect(duration(3600, units)).toBe('1 ч 0 мин');
  });
});
