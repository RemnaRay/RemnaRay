import { createHmac, createSign } from 'node:crypto';

import { expect, test, type BrowserContext } from '@playwright/test';

import { stackState } from '../setup/fixtures';

/** A link the bot's «Открыть кабинет» button carries (section 13.3). */
async function botLink(context: BrowserContext, baseURL: string): Promise<string> {
  const state = stackState();
  const issued = await context.request.post(`${state.apiUrl}/api/internal/v1/auth/issue-token`, {
    headers: { 'x-internal-token': state.internalToken, 'content-type': 'application/json' },
    data: { telegramId: state.user.telegramId },
  });
  expect(issued.ok()).toBeTruthy();
  const { token } = (await issued.json()) as { token: string };
  return `${baseURL}/auth/tg?token=${encodeURIComponent(token)}`;
}

/**
 * Signs in the way the bot's button does: the link opens a page naming the
 * account, and the customer confirms (L-3).
 */
async function signIn(context: BrowserContext, baseURL: string): Promise<string> {
  const state = stackState();
  const page = await context.newPage();
  await page.goto(await botLink(context, baseURL));
  await expect(page.getByText(new RegExp(`@${state.user.username}`, 'u'))).toBeVisible();
  await page.getByRole('button', { name: /^(Войти|Sign in)$/u }).click();
  await page.waitForURL(/\/(ru|en)\/account/u);
  const location = page.url();
  await page.close();
  return location;
}

/**
 * An id_token as Telegram's OIDC login returns it (F29), signed with the key
 * the stand's local JWKS publishes under `oidc-1`.
 */
function oidcToken(privateKey: string, claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'RS256', kid: 'oidc-1', typ: 'JWT' })}.${encode(claims)}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey, 'base64url')}`;
}

test.describe('customer account', () => {
  test('redirects an anonymous visitor to the landing with the login modal', async ({ page }) => {
    await page.goto('/ru/account');
    await expect(page).toHaveURL(/\/ru\?login=1$/u);
    await expect(page.getByRole('dialog', { name: 'Вход в личный кабинет' })).toBeVisible();
  });

  test('signs in with Telegram OIDC on the landing into the localized account (F29)', async ({
    page,
  }) => {
    const state = stackState();
    test.skip(!state.oidcPrivateKey, 'the external stand does not publish local OIDC keys');
    await page.goto('/ru');
    await page.getByRole('button', { name: 'Войти', exact: true }).first().click();
    await page.waitForFunction(
      () =>
        typeof (globalThis as unknown as { onRemnaRayTelegramOidc?: unknown })
          .onRemnaRayTelegramOidc === 'function',
    );
    // The nonce this browser holds (the page asked for one too; the cookie
    // keeps the latest), as the Telegram popup would carry it.
    const { clientId, nonce } = await page.evaluate(async () => {
      const response = await fetch('/api/v1/auth/telegram/nonce', { credentials: 'include' });
      return (await response.json()) as { clientId: string; nonce: string };
    });
    // Shaped as a live token (F34, 2026-09-26): 30 seconds of life and the
    // Telegram id as a string of digits.
    const now = Math.floor(Date.now() / 1000);
    const idToken = oidcToken(state.oidcPrivateKey ?? '', {
      iss: 'https://oauth.telegram.org',
      aud: clientId,
      sub: 'opaque-subject',
      iat: now,
      exp: now + 30,
      nonce,
      id: state.user.telegramId,
      name: state.user.firstName,
      given_name: state.user.firstName,
      preferred_username: state.user.username,
    });
    await page.evaluate((token) => {
      (
        globalThis as unknown as {
          onRemnaRayTelegramOidc?: (result: { id_token: string }) => void;
        }
      ).onRemnaRayTelegramOidc?.({ id_token: token });
    }, idToken);
    await page.waitForURL(/\/ru\/account$/u);
  });

  test('shows an account CTA for a signed-in user on the landing', async ({
    context,
    page,
    baseURL,
  }) => {
    await signIn(context, baseURL ?? '');
    await page.goto('/ru');
    const account = page.getByRole('link', { name: 'Личный кабинет' }).first();
    await expect(account).toBeVisible();
    await account.click();
    await expect(page).toHaveURL(/\/ru\/account$/u);
  });

  test('the bot`s link asks before it signs in, and works once (L-3, R79)', async ({
    context,
    page,
    baseURL,
  }) => {
    const link = await botLink(context, baseURL ?? '');
    await page.goto(link);
    await expect(page).toHaveURL(/\/(ru|en)\/auth\/tg$/u);
    // Nothing is signed in before the button.
    expect((await context.cookies()).some((cookie) => cookie.name === 'rr_sid')).toBe(false);
    await page.getByRole('button', { name: /^(Войти|Sign in)$/u }).click();
    await page.waitForURL(/\/(ru|en)\/account/u);

    await context.clearCookies();
    await page.goto(link);
    await expect(
      page.getByText(/invalid or already used|недействительна или уже использована/u),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Войти|Sign in)$/u })).toHaveCount(0);
  });

  test('preserves the selected locale when the bot opens the account', async ({
    context,
    page,
    baseURL,
  }) => {
    await page.goto('/en');
    const location = await signIn(context, baseURL ?? '');
    expect(location).toMatch(/\/en\/account$/u);
  });

  test('shows the empty subscription state after signing in from the bot', async ({
    context,
    page,
    baseURL,
  }) => {
    await signIn(context, baseURL ?? '');
    await page.goto('/ru/account');

    await expect(page.getByRole('heading', { name: 'Подписка' })).toBeVisible();
    await expect(page.locator('[data-state="empty"]')).toBeVisible();
    await expect(page.getByText('У вас нет подписки')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Выбрать тариф' })).toBeVisible();
  });

  test('lists plans with the balance method first and a promo code field', async ({
    context,
    page,
    baseURL,
  }) => {
    await signIn(context, baseURL ?? '');
    await page.goto('/ru/account/plans');

    await expect(page.locator('[data-state="ready"]')).toBeVisible();
    await expect(page.getByText(stackState().plan.name).first()).toBeVisible();
    await expect(page.getByLabel('Промокод')).toBeVisible();
    const radios = page.locator('input[type="radio"][name="provider"]');
    await expect(radios.first()).toBeVisible();
  });

  test('applies a promo code with one button next to the field, to every plan', async ({
    context,
    page,
    baseURL,
  }) => {
    await signIn(context, baseURL ?? '');
    await page.goto('/ru/account/plans');
    await expect(page.locator('[data-state="ready"]')).toBeVisible();

    await page.getByLabel('Промокод').fill('e2e10');
    const apply = page.getByRole('button', { name: 'Применить' });
    await expect(apply).toHaveCount(1);
    // Next to the field, not inside a plan card.
    await expect(
      page.getByLabel('Промокод').locator('xpath=../..').getByRole('button', { name: 'Применить' }),
    ).toHaveCount(1);
    await apply.click();
    // 10 % of 299 ₽: 29,90 ₽ off, 269,10 ₽ to pay.
    await expect(page.getByText(/269,10/u).first()).toBeVisible();
  });

  test('shows the balance, its history and the top-up presets', async ({
    context,
    page,
    baseURL,
  }) => {
    await signIn(context, baseURL ?? '');
    await page.goto('/ru/account/balance');

    await expect(page.getByText('Текущий баланс')).toBeVisible();
    await expect(page.getByText('500 ₽').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Пополнить' }).first()).toBeVisible();
    await expect(page.locator('[data-state="empty"]')).toBeVisible();
  });

  test('saves a settings change and keeps it after a reload', async ({
    context,
    page,
    baseURL,
  }) => {
    await signIn(context, baseURL ?? '');
    await page.goto('/ru/account/settings');

    const email = page.getByLabel('Email для чеков');
    await email.fill('receipts@example.test');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Сохранено', { exact: true }).first()).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Email для чеков')).toHaveValue('receipts@example.test');
  });

  test('signs out and returns to the landing', async ({ context, page, baseURL }) => {
    await signIn(context, baseURL ?? '');
    await page.goto('/ru/account');
    await page.getByRole('button', { name: 'Выйти' }).click();

    await expect(page).toHaveURL(/\/ru$/u);
    await page.goto('/ru/account');
    await expect(page).toHaveURL(/\/ru\?login=1$/u);
  });

  test('replays an invoice request with the same Idempotency-Key (section 9.2)', async ({
    request,
  }) => {
    const state = stackState();
    const headers = {
      'x-internal-token': state.internalToken,
      'x-acting-user': state.user.telegramId,
      'content-type': 'application/json',
    };
    const config = (await (
      await request.get(`${state.apiUrl}/api/internal/v1/me/topup-config`, { headers })
    ).json()) as { minMinor: number };
    const create = (amountMinor: number, key?: string) =>
      request.post(`${state.apiUrl}/api/internal/v1/me/invoices`, {
        headers: { ...headers, ...(key ? { 'idempotency-key': key } : {}) },
        data: { kind: 'topup', provider: 'mock', amountMinor },
      });
    const key = crypto.randomUUID();

    const first = await create(config.minMinor, key);
    expect(first.status()).toBe(201);
    expect(first.headers()['idempotent-replay']).toBeUndefined();
    const again = await create(config.minMinor, key);
    expect(again.status()).toBe(201);
    expect(again.headers()['idempotent-replay']).toBe('true');
    expect(((await again.json()) as { id: string }).id).toBe(
      ((await first.json()) as { id: string }).id,
    );

    const reused = await create(config.minMinor + 100, key);
    expect(reused.status()).toBe(422);
    expect(await reused.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    expect((await create(config.minMinor)).status()).toBe(400);
  });

  test('leaves no invoice to check when the balance cannot pay it (FR-070, section 11.3.7)', async ({
    request,
  }) => {
    const state = stackState();
    // A customer the bot has just met, with nothing on the balance.
    const telegramId = String(997_000_000 + Math.floor(Math.random() * 999_999));
    const met = await request.post(`${state.apiUrl}/api/internal/v1/users/upsert`, {
      headers: { 'x-internal-token': state.internalToken, 'content-type': 'application/json' },
      data: { telegramId, firstName: 'Broke' },
    });
    expect(met.ok()).toBeTruthy();
    const headers = {
      'x-internal-token': state.internalToken,
      'x-acting-user': telegramId,
      'content-type': 'application/json',
    };
    const key = crypto.randomUUID();
    const buy = () =>
      request.post(`${state.apiUrl}/api/internal/v1/me/invoices`, {
        headers: { ...headers, 'idempotency-key': key },
        data: { kind: 'purchase', planId: state.plan.id, provider: 'balance' },
      });

    const refused = await buy();
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'INSUFFICIENT_FUNDS' } });
    // The same request again is refused again: no pending invoice was left
    // behind for «Проверить» to mark paid.
    const again = await buy();
    expect(again.status()).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'INSUFFICIENT_FUNDS' } });

    // FR-071: a top-up is paid through a provider, never from the balance itself.
    const config = (await (
      await request.get(`${state.apiUrl}/api/internal/v1/me/topup-config`, { headers })
    ).json()) as { minMinor: number };
    const topup = await request.post(`${state.apiUrl}/api/internal/v1/me/invoices`, {
      headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
      data: { kind: 'topup', provider: 'balance', amountMinor: config.minMinor },
    });
    expect(topup.status()).toBe(409);
    expect(await topup.json()).toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } });
  });

  test('answers an invalid field with 400 VALIDATION_ERROR and its path (section 9.3)', async ({
    request,
  }) => {
    const state = stackState();
    const response = await request.patch(`${state.apiUrl}/api/internal/v1/me`, {
      headers: {
        'x-internal-token': state.internalToken,
        'x-acting-user': state.user.telegramId,
        'content-type': 'application/json',
        'x-request-id': 'e2e-validation-1',
      },
      data: { email: 'not an email' },
    });
    expect(response.status()).toBe(400);
    const body = (await response.json()) as { error: { requestId: string } };
    expect(body).toMatchObject({
      error: { code: 'VALIDATION_ERROR', details: [{ path: 'email' }] },
    });
    // The id is the `X-Request-Id` the API received and answers with: ours on
    // a direct call, the proxy's own behind one (section 21: the proxy
    // generates it for every request).
    const answered = response
      .headersArray()
      .filter(({ name }) => name.toLowerCase() === 'x-request-id')
      .map(({ value }) => value);
    expect(answered).toContain(body.error.requestId);
    if (process.env.RR_E2E_EXTERNAL_STACK !== 'true')
      expect(body.error.requestId).toBe('e2e-validation-1');
  });

  test('buys a plan with the mock provider and sees the invoice paid', async ({
    context,
    page,
    baseURL,
  }) => {
    const state = stackState();
    await signIn(context, baseURL ?? '');
    await page.goto('/ru/account/plans');
    await expect(page.locator('[data-state="ready"]')).toBeVisible();

    await page.locator('input[type="radio"][name="provider"][value="mock"]').check();
    await page.getByRole('button', { name: 'Оплатить' }).first().click();

    await page.waitForURL(/\/ru\/pay\/[\w-]+$/u);
    await expect(page.getByText('Ожидание оплаты').first()).toBeVisible();

    // The provider confirms out of band, exactly as a real webhook does. It
    // knows the invoice by its own reference, which is the last segment of the
    // payment URL.
    const paymentUrl = await page
      .getByRole('link', { name: 'Перейти к оплате' })
      .getAttribute('href');
    const providerInvoiceId = (paymentUrl ?? '').split('/').pop() ?? '';
    expect(providerInvoiceId).not.toBe('');
    const body = JSON.stringify({
      eventId: `e2e-${providerInvoiceId}`,
      providerInvoiceId,
      type: 'paid',
      paidAmountMinorRub: '29900',
    });
    const accepted = await context.request.post(`${state.apiUrl}/webhooks/mock`, {
      headers: {
        'content-type': 'application/json',
        'x-mock-signature': createHmac('sha256', 'mock-secret').update(body).digest('hex'),
      },
      data: body,
    });
    expect(accepted.ok()).toBeTruthy();

    await expect(page.getByText('Оплачено').first()).toBeVisible({ timeout: 15_000 });
  });
});
