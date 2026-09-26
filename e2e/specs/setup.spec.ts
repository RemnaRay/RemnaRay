import { expect, test } from '@playwright/test';

import { freshTotp, stackState } from '../setup/fixtures';

const wizard = () => stackState().wizard;

/**
 * AC-171: E2E-02 steps 4–11 against the mocked panel and Telegram, followed by
 * the 404 section 17.4 requires when `/setup` is opened again.
 */
test.describe('setup wizard', () => {
  test('runs the eight steps and then answers 404', async ({ page, context }) => {
    const state = wizard();

    // Step 3 of E2E-02: any path redirects to the wizard while it is pending.
    await page.goto(`${state.baseURL}/ru`);
    await expect(page).toHaveURL(`${state.baseURL}/setup`);

    // Step 4: the setup token.
    await page.getByLabel('Токен').fill(state.setupToken);
    await page.getByRole('button', { name: 'Продолжить' }).click();
    await expect(page.getByRole('heading', { name: 'Администратор' })).toBeVisible();

    // Step 5: the administrator, confirmed with a real TOTP code.
    await page.getByLabel('Email').fill('owner@wizard.test');
    await page.getByLabel('Пароль', { exact: true }).fill('WizardPassword123');
    await page.getByLabel('Пароль ещё раз').fill('WizardPassword123');
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.getByRole('img', { name: /QR/u })).toBeVisible();

    await page.getByText('Показать секрет строкой').click();
    const otpauth = await page.locator('details p').innerText();
    const secret = new URL(otpauth.replace('otpauth://', 'https://')).searchParams.get('secret');
    expect(secret).toBeTruthy();
    await page.getByLabel('Код из приложения').fill(await freshTotp(secret ?? '', 'setup'));
    await page.getByRole('button', { name: 'Подтвердить' }).click();

    // Step: the domain.
    await expect(page.getByRole('heading', { name: 'Домен' })).toBeVisible();
    await page.getByLabel('Основной домен').fill('shop.example.test');
    await page.getByLabel('Email для ACME').fill('ops@example.test');
    await page.getByRole('button', { name: 'Далее' }).click();

    // Step 6: the panel, checked before it can be saved.
    await expect(page.getByRole('heading', { name: 'Панель' })).toBeVisible();
    await page.getByLabel('Адрес панели').fill(state.panelUrl);
    await page.getByLabel('Токен API').fill('panel-token');
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.getByText('Проверка прошла')).toBeVisible();
    await expect(page.getByText('Сквадов найдено: 1')).toBeVisible();
    await expect(page.getByText('WEBHOOK_URL=')).toBeVisible();
    await page.getByRole('button', { name: 'Далее' }).click();

    // Step 7: the bot, verified with getMe.
    await expect(page.getByRole('heading', { name: 'Бот' })).toBeVisible();
    await page.getByLabel('Токен бота', { exact: true }).fill(state.botToken);
    await page.getByLabel('Контакт поддержки').fill('@manta_support');
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.getByText('Бот: @manta_setup_bot')).toBeVisible();
    await page.getByRole('button', { name: 'Далее' }).click();

    // Step 8: the brand.
    await expect(page.getByRole('heading', { name: 'Бренд' })).toBeVisible();
    await page.getByLabel('Название магазина').fill('Manta Wizard');
    await page.getByRole('button', { name: 'Далее' }).click();

    // Step 9: the first plan and the trial.
    await expect(page.getByRole('heading', { name: 'Тариф и триал' })).toBeVisible();
    await page.getByLabel('Цена, ₽').fill('299');
    await page.getByRole('button', { name: 'Далее' }).click();

    // Step 10: each provider is a form of its own fields (FR-061), not JSON;
    // payments may be skipped.
    await expect(page.getByRole('heading', { name: 'Платежи и чеки' })).toBeVisible();
    await page.getByRole('checkbox', { name: 'ЮKassa' }).check();
    await expect(page.getByLabel('ID магазина (shopId) *')).toBeVisible();
    await expect(page.getByLabel('Секретный ключ *')).toHaveAttribute('type', 'password');
    await expect(page.getByRole('button', { name: 'Далее' })).toBeDisabled();
    await page.getByRole('checkbox', { name: 'ЮKassa' }).uncheck();
    await page.getByRole('button', { name: 'Пропустить' }).click();

    // Step 11: the summary and the launch.
    await expect(page.getByRole('heading', { name: 'Готово' })).toBeVisible();
    await expect(page.getByText('shop.example.test')).toBeVisible();
    await expect(page.getByText('manta_setup_bot')).toBeVisible();
    await page.getByRole('button', { name: 'Запустить магазин' }).click();
    await expect(page.getByRole('heading', { name: 'Магазин запущен' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Перейти в админку' })).toBeVisible();

    // Section 17.4: reopening `/setup` is a 404 and the wizard API is closed.
    const reopened = await context.request.get(`${state.baseURL}/setup`);
    expect(reopened.status()).toBe(404);
    const api = await context.request.get(`${state.apiUrl}/api/setup/v1/state`);
    expect(api.status()).toBe(404);
    const body = (await api.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('SETUP_ALREADY_COMPLETED');

    // And the shop itself answers again.
    const plans = await context.request.get(`${state.apiUrl}/api/v1/public/plans`);
    expect(plans.status()).toBe(200);
  });
});
