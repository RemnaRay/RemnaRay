'use client';

import { useEffect, useState } from 'react';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@remnaray/ui';

import type { Locale } from '../../i18n/routing';
import LoginWidget from './login-widget';

/**
 * «Войти» opens the sign-in in a modal (section 13.2; owner request F33), and
 * `/?login=1`, where the account pages send a visitor without a session,
 * opens it straight away (section 13.2's middleware note). The Telegram
 * button mounts with the dialog, so the login nonce is asked for on opening.
 */
export default function LoginDialog({
  labels,
  locale,
  openOnLoginQuery = false,
  size,
  variant,
}: {
  labels: {
    trigger: string;
    title: string;
    description: string;
    button: string;
    error: string;
    unavailable: string;
  };
  locale: Locale;
  openOnLoginQuery?: boolean;
  size?: 'md' | 'lg';
  variant?: 'primary' | 'secondary';
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!openOnLoginQuery) return;
    if (new URLSearchParams(window.location.search).get('login') === '1') setOpen(true);
  }, [openOnLoginQuery]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) return;
        // Closing it keeps the page; a reload should not reopen it.
        const url = new URL(window.location.href);
        if (url.searchParams.has('login')) {
          url.searchParams.delete('login');
          window.history.replaceState(window.history.state, '', url);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size={size} variant={variant}>
          {labels.trigger}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>{labels.description}</DialogDescription>
        </DialogHeader>
        <LoginWidget
          errorLabel={labels.error}
          label={labels.button}
          locale={locale}
          unavailableLabel={labels.unavailable}
        />
      </DialogContent>
    </Dialog>
  );
}
