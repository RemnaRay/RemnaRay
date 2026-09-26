'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { z } from 'zod';

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@remnaray/ui';

import { adminApi } from '../../../lib/admin-client';
import { invalidate, useResource } from '../../../lib/resource';
import { AdminSection } from '../admin-states';

export const supportSchema = z.object({
  contact: z.string(),
  chatId: z.number().nullable(),
  supportBot: z.object({ username: z.string() }).nullable(),
});

/**
 * FR-124 in the console, with the owner's F35 additions: the support contact,
 * the operators' chat and the optional support bot. The token is written, never
 * shown back: the page only knows the bot's username.
 */
export function SupportTab({
  fail,
  notify,
}: {
  fail: (error: unknown) => void;
  notify: (title: string) => void;
}) {
  const resource = useResource('admin:support', () =>
    adminApi().get('api/admin/v1/bot/support', supportSchema),
  );
  return (
    <AdminSection refresh={resource.refresh} state={resource.state}>
      {(data) => <SupportForm data={data} fail={fail} notify={notify} />}
    </AdminSection>
  );
}

function SupportForm({
  data,
  fail,
  notify,
}: {
  data: z.infer<typeof supportSchema>;
  fail: (error: unknown) => void;
  notify: (title: string) => void;
}) {
  const t = useTranslations('admin');
  const [contact, setContact] = useState(data.contact);
  const [chatId, setChatId] = useState(data.chatId === null ? '' : String(data.chatId));
  const [token, setToken] = useState('');
  const [pending, setPending] = useState(false);
  const chatIdValid = chatId.trim() === '' || /^-?\d+$/u.test(chatId.trim());

  const save = (body: Record<string, unknown>) => {
    setPending(true);
    adminApi()
      .send('PUT', 'api/admin/v1/bot/support', z.unknown(), { ...body, reason: 'support settings' })
      .then(() => {
        setToken('');
        invalidate('admin:support');
        notify(t('saved'));
      }, fail)
      .finally(() => {
        setPending(false);
      });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('support.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex max-w-xl flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t('support.description')}</p>
        <div className="flex flex-col gap-1">
          <Label htmlFor="support-contact">{t('support.contact')}</Label>
          <Input
            id="support-contact"
            placeholder="@username"
            value={contact}
            onChange={(event) => {
              setContact(event.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="support-chat">{t('support.chat')}</Label>
          <Input
            aria-invalid={!chatIdValid}
            id="support-chat"
            inputMode="numeric"
            placeholder="-100…"
            value={chatId}
            onChange={(event) => {
              setChatId(event.target.value);
            }}
          />
          <span className="text-xs text-muted-foreground">{t('support.chatHint')}</span>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="support-bot-token">{t('support.bot')}</Label>
          <div className="flex items-center gap-2">
            <Badge variant={data.supportBot ? 'success' : 'secondary'}>
              {data.supportBot
                ? t('support.botSet', { username: data.supportBot.username })
                : t('support.botUnset')}
            </Badge>
          </div>
          <Input
            autoComplete="off"
            id="support-bot-token"
            placeholder={t('support.botPlaceholder')}
            type="password"
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
            }}
          />
          <span className="text-xs text-muted-foreground">{t('support.botHint')}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={pending || !chatIdValid}
            onClick={() => {
              save({
                contact,
                chatId: chatId.trim() === '' ? null : Number(chatId.trim()),
                ...(token ? { token } : {}),
              });
            }}
          >
            {t('settings.save')}
          </Button>
          {data.supportBot ? (
            <Button
              disabled={pending}
              variant="secondary"
              onClick={() => {
                save({ token: '' });
              }}
            >
              {t('support.botRemove')}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
