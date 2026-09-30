import { expect, test } from '@playwright/test';

import { stackState } from '../setup/fixtures';

test.describe('administration console', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/admin');
  });

  test('dashboard renders the widgets and both charts', async ({ page }) => {
    await expect(page.locator('[data-state="ready"]')).toBeVisible();
    // F37: provider money is «Поступления», plans bought are «Продажи».
    await expect(page.getByText('Поступления', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Продажи', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Поступления по дням')).toBeVisible();
    await expect(page.getByText('Регистрации по дням')).toBeVisible();
    await expect(page.getByText('Требует внимания')).toBeVisible();
  });

  test('finds the seeded user and opens the card', async ({ page }) => {
    const state = stackState();
    await page.getByRole('link', { name: 'Пользователи' }).click();
    await page.getByLabel('Поиск').fill(state.user.telegramId);
    await page.getByRole('button', { name: 'Применить' }).click();

    await expect(page.getByText(state.user.username)).toBeVisible();
    await page.getByRole('link', { name: 'Открыть' }).click();
    await expect(page.getByRole('heading', { name: state.user.firstName })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Журнал' })).toBeVisible();
  });

  test('shows the action journal', async ({ page }) => {
    await page.goto('/admin/audit');
    await expect(page.locator('[data-state="ready"], [data-state="empty"]').first()).toBeVisible();
  });

  test('creates a plan and shows it in the list', async ({ page }) => {
    await page.getByRole('link', { name: 'Тарифы' }).click();

    await page.getByLabel('Идентификатор').fill('e2e-week');
    await page.getByLabel('Название (ru)').fill('Неделя');
    await page.getByLabel('Название (en)').fill('Week');
    await page.getByLabel('Дней').fill('7');
    await page.getByLabel('Цена').fill('99');
    // FR-145: the squads come from the panel, and a plan needs one (section 8).
    const save = page.getByRole('button', { name: 'Сохранить', exact: true });
    await expect(save).toBeDisabled();
    await page.getByRole('checkbox', { name: 'Default' }).check();
    await save.click();

    await expect(page.getByText('e2e-week')).toBeVisible();

    // And it can be edited afterwards.
    await page
      .getByRole('row', { name: /e2e-week/u })
      .getByRole('button', { name: 'Изменить' })
      .click();
    await expect(page.getByText('Тариф e2e-week')).toBeVisible();
    await page.getByLabel('Описание (ru)').fill('Семь дней доступа');
    await save.click();
    await expect(page.getByText('Тариф e2e-week')).toBeHidden();
  });

  test('settings show the provider health gate from AC-061', async ({ page }) => {
    await page.goto('/admin/settings');
    await page.getByRole('tab', { name: 'Платежи' }).click();

    await expect(
      page.getByText('Без успешной проверки провайдер не показывается пользователям.'),
    ).toBeVisible();
    await expect(page.getByText('mock')).toBeVisible();
  });

  test('configures a provider through its form and checks it (FR-061)', async ({ page }) => {
    await page.goto('/admin/settings');
    await page.getByRole('tab', { name: 'Платежи' }).click();
    await page.getByRole('button', { name: 'Настроить' }).first().click();

    await expect(page.getByText('Настройки: Mock')).toBeVisible();
    await expect(page.getByLabel('Название для покупателей (ru)')).toHaveValue('Тест');
    await page.getByRole('button', { name: 'Сохранить и проверить' }).click();
    await expect(page.getByText('Сохранено, проверка: ok', { exact: true })).toBeVisible();
  });

  test('system page lists the queues and the health endpoint', async ({ page }) => {
    await page.goto('/admin/system');

    await expect(page.getByRole('heading', { name: 'Очереди' })).toBeVisible();
    await expect(page.getByRole('link', { name: '/api/v1/health' })).toBeVisible();
  });

  test('a forged mutation is refused (section 9.2)', async ({ page }) => {
    // Issued from the page, so it carries the administrator session cookie but
    // neither the custom header nor the CSRF token the console sends.
    const status = await page.evaluate(async () => {
      const response = await fetch('/api/admin/v1/plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: 'csrf-attempt',
          name: { ru: 'X', en: 'X' },
          durationDays: 1,
          priceMinor: 1,
        }),
      });
      return response.status;
    });
    expect(status).toBe(403);
  });

  test('a mutation with the header but a wrong CSRF token is refused', async ({ page }) => {
    const status = await page.evaluate(async () => {
      const response = await fetch('/api/admin/v1/plans', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'RemnaRay',
          'x-csrf-token': 'x'.repeat(43),
        },
        body: JSON.stringify({
          slug: 'csrf-attempt',
          name: { ru: 'X', en: 'X' },
          durationDays: 1,
          priceMinor: 1,
        }),
      });
      return response.status;
    });
    expect(status).toBe(403);
  });

  test('a balance credit repeated with its Idempotency-Key is applied once (section 9.1)', async ({
    page,
  }) => {
    const { user } = stackState();
    const reason = `e2e idempotent credit ${String(Date.now())}`;
    const outcome = await page.evaluate(
      async ({ userId, reason }) => {
        const me = (await (await fetch('/api/admin/v1/auth/me')).json()) as { csrfToken: string };
        const headers = {
          'content-type': 'application/json',
          'x-requested-with': 'RemnaRay',
          'x-csrf-token': me.csrfToken,
        };
        const balance = async () =>
          (
            (await (await fetch(`/api/admin/v1/users/${userId}`)).json()) as {
              balance: { amountMinor: number };
            }
          ).balance.amountMinor;
        const credit = (key: string, amountMinor: number) =>
          fetch(`/api/admin/v1/users/${userId}/balance`, {
            method: 'POST',
            headers: { ...headers, 'idempotency-key': key },
            body: JSON.stringify({ amountMinor, reason }),
          });

        const before = await balance();
        const key = crypto.randomUUID();
        const first = await credit(key, 1234);
        const again = await credit(key, 1234);
        const after = await balance();
        const audit = (await (await fetch(`/api/admin/v1/users/${userId}/audit`)).json()) as {
          items: { action: string; reason: string | null }[];
        };
        // Put the balance back for the other specs.
        await credit(crypto.randomUUID(), before - after);
        return {
          statuses: [first.status, again.status],
          bodies: [await first.json(), await again.json()],
          replay: again.headers.get('idempotent-replay'),
          credited: after - before,
          audited: audit.items.filter(
            (item) => item.action === 'users.balance' && item.reason === reason,
          ).length,
        };
      },
      { userId: user.id, reason },
    );

    expect(outcome.statuses).toEqual([200, 200]);
    expect(outcome.credited).toBe(1234);
    expect(outcome.replay).toBe('true');
    expect(outcome.bodies[1]).toEqual(outcome.bodies[0]);
    expect(outcome.audited).toBe(1);
  });

  test('confirming a credit again after a lost answer credits once (section 9.1)', async ({
    page,
  }) => {
    const { user } = stackState();
    const balance = () =>
      page.evaluate(
        async (userId) =>
          (
            (await (await fetch(`/api/admin/v1/users/${userId}`)).json()) as {
              balance: { amountMinor: number };
            }
          ).balance.amountMinor,
        user.id,
      );

    // The first credit reaches the API and is applied, but its answer never
    // reaches the console, which shows an error and keeps the dialog open.
    let lost: number | undefined;
    await page.route(`**/api/admin/v1/users/${user.id}/balance`, async (route) => {
      if (lost !== undefined) return route.continue();
      lost = 0;
      // The same request, sent from the page so the browser adds what the
      // CSRF check reads (`Sec-Fetch-Site`); this handler lets it through.
      const request = route.request();
      const headers = Object.fromEntries(
        Object.entries(request.headers()).filter(([name]) =>
          ['content-type', 'x-requested-with', 'x-csrf-token', 'idempotency-key'].includes(name),
        ),
      );
      lost = await page.evaluate(
        async ({ url, headers, body }) =>
          (await fetch(url, { method: 'POST', headers, body })).status,
        { url: request.url(), headers, body: request.postData() },
      );
      return route.abort();
    });

    await page.goto(`/admin/users/${user.id}`);
    const before = await balance();
    await page.getByRole('button', { name: 'Начислить' }).click();
    await page.getByLabel('Сумма').fill('12');
    await page.getByLabel('Причина').fill('e2e lost answer');
    await page.getByRole('button', { name: 'Подтвердить' }).click();
    await expect.poll(() => lost).toBe(200);
    await expect(page.getByRole('button', { name: 'Подтвердить' })).toBeEnabled();
    await page.getByRole('button', { name: 'Подтвердить' }).click();
    await expect(page.getByText('Сохранено').first()).toBeVisible();

    const credited = (await balance()) - before;
    // Put the balance back for the other specs.
    await page.evaluate(
      async ({ userId, amountMinor }) => {
        const me = (await (await fetch('/api/admin/v1/auth/me')).json()) as { csrfToken: string };
        await fetch(`/api/admin/v1/users/${userId}/balance`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-requested-with': 'RemnaRay',
            'x-csrf-token': me.csrfToken,
            'idempotency-key': crypto.randomUUID(),
          },
          body: JSON.stringify({ amountMinor, reason: 'e2e restore' }),
        });
      },
      { userId: user.id, amountMinor: -credited },
    );
    expect(credited).toBe(1200);
  });

  test('the administration surface is never indexed', async ({ page }) => {
    const robots = await page.request.get('/robots.txt');
    expect(await robots.text()).toContain('Disallow: /admin');
  });
});
