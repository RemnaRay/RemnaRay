'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button, Card, CardContent, CardHeader, CardTitle } from '@remnaray/ui';

import { Link, useRouter } from '../../../../i18n/navigation';
import type { Locale } from '../../../../i18n/routing';

type Account = { firstName: string | null; username: string | null };

const HEADERS = { 'content-type': 'application/json', 'X-Requested-With': 'RemnaRay' };

/** The token the bot's link carried in the fragment, or null. */
function tokenFrom(fragment: string): string | null {
  try {
    const value = decodeURIComponent(fragment.replace(/^#/u, ''));
    return value ? value : null;
  } catch {
    return null;
  }
}

/**
 * L-3 (owner decision 2026-09-28): the bot's link signs in only when the
 * visitor, shown whose account it opens, presses the button — a link someone
 * else handed over cannot sign them in unasked. The exchange is a same-origin
 * POST, and it spends the link (R79).
 */
export default function BotSignIn({ locale }: { locale: Locale }) {
  const t = useTranslations('account');
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const value = tokenFrom(window.location.hash);
    // The token leaves the address bar and the history.
    window.history.replaceState(null, '', window.location.pathname);
    if (!value) {
      setAccount(null);
      return;
    }
    setToken(value);
    void fetch('/api/v1/auth/tg/preview', {
      method: 'POST',
      headers: HEADERS,
      credentials: 'include',
      body: JSON.stringify({ token: value }),
    })
      .then((response) => (response.ok ? (response.json() as Promise<{ user: Account }>) : null))
      .then((body) => {
        setAccount(body?.user ?? null);
      })
      .catch(() => {
        setAccount(null);
      });
  }, []);

  const signIn = () => {
    if (!token) return;
    setBusy(true);
    setFailed(false);
    void fetch('/api/v1/auth/tg', {
      method: 'POST',
      headers: HEADERS,
      credentials: 'include',
      body: JSON.stringify({ token }),
    })
      .then((response) => {
        if (!response.ok) throw new Error('sign-in-failed');
        router.replace('/account', { locale });
      })
      .catch(() => {
        setBusy(false);
        setFailed(true);
      });
  };

  const name = account
    ? [account.firstName, account.username ? `(@${account.username})` : null]
        .filter(Boolean)
        .join(' ')
    : '';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('botSignIn.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {account === null ? (
          <>
            <p className="text-sm text-muted-foreground" role="alert">
              {t('botSignIn.invalid')}
            </p>
            <Link className="text-sm underline" href="/">
              {t('botSignIn.home')}
            </Link>
          </>
        ) : account ? (
          <>
            <p className="text-base">
              {name ? t('botSignIn.as', { name }) : t('botSignIn.asUnnamed')}
            </p>
            <p className="text-sm text-muted-foreground">{t('botSignIn.hint')}</p>
            <Button disabled={busy} onClick={signIn}>
              {t('botSignIn.confirm')}
            </Button>
            {failed ? (
              <p className="text-sm text-destructive" role="alert">
                {t('botSignIn.failed')}
              </p>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
