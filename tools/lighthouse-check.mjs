/**
 * NFR-010 and the TASK-M4-003 acceptance gate: Lighthouse performance >= 90,
 * accessibility >= 90 and SEO >= 95 for the landing, and accessibility >= 90
 * for the account (section 13.2).
 *
 * The measurement runs against the same production stack the Playwright suite
 * uses — the API from `dist`, the site from its standalone build and a reverse
 * proxy in front of both — so the numbers describe the deployed artefacts and
 * not a development server.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { chromium } from '@playwright/test';
import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';

import { startStack } from '../e2e/setup/stack.mjs';

const REPORT_DIRECTORY = resolve(process.cwd(), 'test-results/lighthouse');

/** Section 13.2 thresholds; the account only carries the NFR-010 a11y gate. */
const TARGETS = [
  { name: 'landing-ru', path: '/ru', thresholds: { performance: 90, accessibility: 90, seo: 95 } },
  { name: 'landing-en', path: '/en', thresholds: { performance: 90, accessibility: 90, seo: 95 } },
  {
    name: 'account',
    path: '/account',
    signIn: true,
    // The locale is negotiated from `Accept-Language`, so either prefix is right.
    expected: /^\/(ru|en)\/account$/u,
    thresholds: { accessibility: 90 },
  },
];

/**
 * A customer session, made the way the bot's «Открыть кабинет» link does
 * (section 13.3): the link's token exchanged by the confirmation page's
 * same-origin POST (L-3).
 */
async function sessionCookie(stack) {
  const issued = await globalThis.fetch(`${stack.apiUrl}/api/internal/v1/auth/issue-token`, {
    method: 'POST',
    headers: { 'x-internal-token': stack.internalToken, 'content-type': 'application/json' },
    body: JSON.stringify({ telegramId: stack.user.telegramId }),
  });
  if (!issued.ok) throw new Error(`issue-token failed with ${String(issued.status)}`);
  const { token } = await issued.json();
  const exchanged = await globalThis.fetch(`${stack.baseURL}/api/v1/auth/tg`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'RemnaRay',
      origin: `https://${new globalThis.URL(stack.baseURL).host}`,
    },
    body: JSON.stringify({ token }),
  });
  const cookie = exchanged.headers.get('set-cookie')?.split(';')[0];
  if (!exchanged.ok || !cookie?.startsWith('rr_sid='))
    throw new Error(`the sign-in exchange failed with ${String(exchanged.status)}`);
  return decodeURIComponent(cookie.slice('rr_sid='.length));
}

/**
 * Puts the session into the audited browser's profile — the Lighthouse
 * recipe for authenticated pages; the audit then keeps the storage it would
 * otherwise clear before navigating.
 */
async function signInBrowser(port, baseURL, session) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`);
  try {
    await browser.contexts()[0].addCookies([
      {
        name: 'rr_sid',
        value: session,
        url: baseURL,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
  } finally {
    // Disconnects; the browser Lighthouse drives keeps running.
    await browser.close();
  }
}

async function audit(url, { port, categories, keepStorage }) {
  const { lhr } = await lighthouse(
    url,
    {
      port,
      output: 'json',
      logLevel: 'error',
      onlyCategories: categories,
      ...(keepStorage ? { disableStorageReset: true } : {}),
    },
    desktopConfig,
  );
  return lhr;
}

async function main() {
  const stack = await startStack();
  // `chrome-launcher` rewrites the profile directory into a Windows path when
  // it detects WSL, which a Linux Chrome then creates as a literal
  // `C:\...`/`\\wsl.localhost\...` name in the working directory. Opt out of
  // its handling and pass the directory as a flag instead.
  const profile = mkdtempSync(join(tmpdir(), 'remnaray-lighthouse-'));
  const chrome = await chromeLauncher.launch({
    // `CHROME_PATH` wins so a machine without the full Chromium runtime can
    // point the run at `chrome-headless-shell`; CI uses Playwright's Chromium.
    chromePath: process.env.CHROME_PATH ?? chromium.executablePath(),
    chromeFlags: [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      `--user-data-dir=${profile}`,
    ],
    userDataDir: false,
  });
  mkdirSync(REPORT_DIRECTORY, { recursive: true });

  const failures = [];
  try {
    for (const target of TARGETS) {
      const categories = Object.keys(target.thresholds);
      if (target.signIn)
        await signInBrowser(chrome.port, stack.baseURL, await sessionCookie(stack));
      const lhr = await audit(`${stack.baseURL}${target.path}`, {
        port: chrome.port,
        categories,
        keepStorage: target.signIn === true,
      });
      const expected = target.expected ?? new RegExp(`^${target.path}$`, 'u');
      if (!expected.test(new globalThis.URL(lhr.finalDisplayedUrl).pathname))
        throw new Error(
          `${target.name} ended on ${lhr.finalDisplayedUrl}; the audit would not describe ${target.path}`,
        );
      writeFileSync(
        resolve(REPORT_DIRECTORY, `${target.name}.json`),
        JSON.stringify(lhr, null, 2),
        'utf8',
      );

      const scores = categories.map((category) => {
        const score = Math.round((lhr.categories[category].score ?? 0) * 100);
        const threshold = target.thresholds[category];
        if (score < threshold)
          failures.push(`${target.name} ${category} ${String(score)} < ${String(threshold)}`);
        return `${category} ${String(score)}/${String(threshold)}`;
      });
      process.stdout.write(`${target.name} (${target.path}): ${scores.join(', ')}\n`);
    }
  } finally {
    await chrome.kill();
    rmSync(profile, { force: true, recursive: true });
    await stack.stop();
  }

  if (failures.length > 0) {
    process.stderr.write(`Lighthouse below the section 13.2 thresholds: ${failures.join('; ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Lighthouse thresholds met; reports written to ${REPORT_DIRECTORY}.\n`);
}

await main();
