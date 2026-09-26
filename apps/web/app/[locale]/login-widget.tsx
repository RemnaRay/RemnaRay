'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@remnaray/ui';

import { useRouter } from '../../i18n/navigation';
import type { Locale } from '../../i18n/routing';

/** What `telegram-login.js` hands the callback (core.telegram.org/widgets/login). */
type TelegramLoginResult = { id_token?: string; error?: string };

declare global {
  interface Window {
    Telegram?: {
      Login?: {
        auth: (
          options: { client_id: number; nonce: string; lang?: string },
          callback: (result: TelegramLoginResult) => void,
        ) => void;
      };
    };
    onRemnaRayTelegramOidc?: (result: TelegramLoginResult) => void;
  }
}

const LIBRARY = 'https://oauth.telegram.org/js/telegram-login.js?6';

/**
 * Telegram Login over OpenID Connect (owner decision F29). The API hands this
 * browser a nonce (and the bot's Client ID) before the button is pressed, so
 * the popup opens inside the click; Telegram returns an `id_token` carrying
 * the nonce, and the API checks both before it opens the session. The site's
 * origin must be an Allowed URL of the bot in the BotFather mini app.
 */
export default function LoginWidget({
  unavailableLabel,
  label,
  errorLabel,
  locale,
}: {
  unavailableLabel: string;
  label: string;
  errorLabel: string;
  locale: Locale;
}) {
  const router = useRouter();
  const [error, setError] = useState(false);
  const [login, setLogin] = useState<{ clientId: string; nonce: string } | null | undefined>(
    undefined,
  );

  const prepare = useCallback(() => {
    void fetch('/api/v1/auth/telegram/nonce', { credentials: 'include', cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { clientId?: string | null; nonce?: string } | null) => {
        setLogin(
          body?.clientId && body.nonce ? { clientId: body.clientId, nonce: body.nonce } : null,
        );
      })
      .catch(() => {
        setLogin(null);
      });
  }, []);

  useEffect(() => {
    prepare();
    if (!document.querySelector(`script[src="${LIBRARY}"]`)) {
      const script = document.createElement('script');
      script.src = LIBRARY;
      script.async = true;
      document.head.append(script);
    }
  }, [prepare]);

  useEffect(() => {
    window.onRemnaRayTelegramOidc = (result) => {
      setError(false);
      if (!result.id_token) {
        if (result.error) setError(true);
        prepare();
        return;
      }
      void fetch('/api/v1/auth/telegram/oidc', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Requested-With': 'RemnaRay' },
        credentials: 'include',
        body: JSON.stringify({ idToken: result.id_token }),
      })
        .then((response) => {
          if (!response.ok) throw new Error('telegram-auth-failed');
          router.replace('/account', { locale });
        })
        .catch(() => {
          setError(true);
          // The nonce is spent; the next attempt needs a new one.
          prepare();
        });
    };
    return () => {
      delete window.onRemnaRayTelegramOidc;
    };
  }, [locale, prepare, router]);

  if (login === null) return <p className="text-sm text-muted-foreground">{unavailableLabel}</p>;

  return (
    <div aria-label={label} id="login" role="group">
      <Button
        disabled={!login}
        onClick={() => {
          const auth = window.Telegram?.Login?.auth;
          if (!login || !auth) {
            setError(true);
            return;
          }
          auth(
            { client_id: Number(login.clientId), nonce: login.nonce, lang: locale },
            (result) => {
              window.onRemnaRayTelegramOidc?.(result);
            },
          );
        }}
      >
        {label}
      </Button>
      {error ? (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {errorLabel}
        </p>
      ) : null}
    </div>
  );
}
