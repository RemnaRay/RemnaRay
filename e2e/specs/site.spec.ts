import { expect, test } from '@playwright/test';

import { stackState } from '../setup/fixtures';

test.describe('public site', () => {
  test('landing shows the brand, the plan and both call-to-actions', async ({ page }) => {
    await page.goto('/ru');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Выберите тариф' })).toBeVisible();
    await expect(page.getByText('299').first()).toBeVisible();
    await expect(page.getByText('30 дней').first()).toBeVisible();
    await expect(
      page.getByRole('link', { name: /t\.me|Открыть в Telegram/u }).first(),
    ).toBeVisible();
    // «Войти» opens the sign-in dialog with the Telegram OIDC button (F29, F33).
    await page.getByRole('button', { name: 'Войти', exact: true }).first().click();
    await expect(
      page
        .getByRole('dialog', { name: 'Вход в личный кабинет' })
        .getByRole('button', { name: 'Войти через Telegram' }),
    ).toBeEnabled();
    await expect(
      page.locator('script[src="https://oauth.telegram.org/js/telegram-login.js?6"]'),
    ).toHaveCount(1);
  });

  test('the footer switches language and remembers it in a secure cookie', async ({
    page,
    context,
  }) => {
    await page.goto('/ru');
    await page.getByRole('button', { name: 'English' }).click();

    await expect(page).toHaveURL(/\/en$/u);
    await expect(page.getByRole('heading', { name: 'Choose a plan' })).toBeVisible();
    const localeCookie = async () =>
      (await context.cookies()).find((cookie) => cookie.name === 'rr_lang');
    await expect
      .poll(localeCookie)
      .toMatchObject({ value: 'en', secure: true, sameSite: 'Lax', path: '/' });
    await page.goto('/');
    await expect(page).toHaveURL(/\/en$/u);

    await page.getByRole('button', { name: 'Русский', exact: true }).click();
    await expect(page).toHaveURL(/\/ru$/u);
    await expect
      .poll(localeCookie)
      .toMatchObject({ value: 'ru', secure: true, sameSite: 'Lax', path: '/' });
    await page.goto('/');
    await expect(page).toHaveURL(/\/ru$/u);
  });

  test('legal pages render the localized document', async ({ page }) => {
    await page.goto('/ru/terms');
    await expect(page.getByRole('heading', { name: 'Условия использования' })).toBeVisible();

    await page.goto('/en/privacy');
    await expect(page.getByRole('heading', { name: 'Privacy policy' })).toBeVisible();
  });

  test('the Robokassa return lands on the invoice page, by GET and by POST', async ({
    request,
  }) => {
    // Section 11.3.4: SuccessURL and FailURL are `https://<domain>/pay/robokassa`;
    // Robokassa appends `Shp_inv` (the invoice id) and `Culture`.
    const invoice = '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
    const query = `OutSum=299.00&InvId=7&SignatureValue=x&Culture=en&Shp_inv=${invoice}`;
    const viaGet = await request.get(`/pay/robokassa?${query}`, { maxRedirects: 0 });
    expect(viaGet.status()).toBe(303);
    expect(viaGet.headers().location).toBe(`/en/pay/${invoice}`);
    const viaPost = await request.post('/pay/robokassa', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      data: query,
      maxRedirects: 0,
    });
    expect(viaPost.status()).toBe(303);
    expect(viaPost.headers().location).toBe(`/en/pay/${invoice}`);
  });

  test('robots and sitemap expose the public routes only', async ({ request }) => {
    const robots = await request.get('/robots.txt');
    expect(robots.ok()).toBeTruthy();
    const robotsBody = await robots.text();
    expect(robotsBody).toContain('Disallow: /account');
    expect(robotsBody).toContain('Disallow: /admin');

    const sitemap = await request.get('/sitemap.xml');
    expect(sitemap.ok()).toBeTruthy();
    const sitemapBody = await sitemap.text();
    expect(sitemapBody).toContain('/ru/terms');
    expect(sitemapBody).toContain('/en/terms');
  });

  test('the public API serves config, theme and plans', async ({ request }) => {
    const state = stackState();

    const config = await request.get('/api/v1/public/config');
    expect(config.ok()).toBeTruthy();
    const configBody = (await config.json()) as { brand: { name: string } };
    expect(configBody.brand.name).toBe(state.brand.name);

    const theme = await request.get('/api/v1/public/theme');
    expect(theme.ok()).toBeTruthy();
    expect(theme.headers()['etag']).toBeTruthy();

    const plans = await request.get('/api/v1/public/plans');
    const body = (await plans.json()) as { items: { slug: string }[] };
    const seeded = body.items.find((item) => item.slug === state.plan.slug);
    expect(seeded).toBeDefined();
    // Section 9.4: the public catalog never carries the panel's squads.
    for (const item of body.items) expect(item).not.toHaveProperty('squads');
  });

  test("the bot's client button opens the client with the link from the fragment", async ({
    page,
  }) => {
    const subscription = 'https://sub.example.test/abc?x=1';
    await page.goto(`/ru/open/happ#${encodeURIComponent(subscription)}`);
    await expect(page.getByRole('link', { name: 'Открыть Happ' })).toHaveAttribute(
      'href',
      `happ://add/${encodeURIComponent(subscription)}`,
    );

    const unknown = await page.goto('/ru/open/no-such-client#x');
    expect(unknown?.status()).toBe(404);
  });

  test('a referral link stores the code and returns to the landing', async ({ page, context }) => {
    await page.goto('/r/E2EUSER1');
    await expect(page).toHaveURL(/\/(ru|en)$/u);
    const cookies = await context.cookies();
    expect(cookies.find((cookie) => cookie.name === 'rr_ref')?.value).toBe('E2EUSER1');
  });
});
