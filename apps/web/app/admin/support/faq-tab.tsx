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
  DataTable,
  Input,
  Label,
} from '@remnaray/ui';

import { adminApi } from '../../../lib/admin-client';
import { invalidate, useResource } from '../../../lib/resource';
import { AdminSection } from '../admin-states';

const localized = z.object({ ru: z.string(), en: z.string() });
export const faqSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      question: localized,
      answer: localized,
      sortOrder: z.number(),
      enabled: z.boolean(),
    }),
  ),
});
type Item = z.infer<typeof faqSchema>['items'][number];

const EMPTY = {
  questionRu: '',
  questionEn: '',
  answerRu: '',
  answerEn: '',
  sortOrder: 100,
  enabled: true,
};
const textarea = 'min-h-24 rounded-md border border-border bg-background p-3 text-sm';

/** Self-help questions the bots offer before «Написать оператору». */
export function FaqTab({
  canWrite,
  fail,
  notify,
}: {
  canWrite: boolean;
  fail: (error: unknown) => void;
  notify: (title: string) => void;
}) {
  const t = useTranslations('admin');
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [pending, setPending] = useState(false);
  const resource = useResource('admin:support:faq', () =>
    adminApi().get('api/admin/v1/support/faq', faqSchema),
  );
  const run = (method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) => {
    setPending(true);
    adminApi()
      .send(method, path, z.unknown(), body)
      .then(() => {
        setEditing(null);
        setForm(EMPTY);
        invalidate('admin:support:faq');
        notify(t('saved'));
      }, fail)
      .finally(() => {
        setPending(false);
      });
  };
  const bodyOf = (item: typeof EMPTY) => ({
    question: { ru: item.questionRu, en: item.questionEn },
    answer: { ru: item.answerRu, en: item.answerEn },
    sortOrder: item.sortOrder,
    enabled: item.enabled,
  });
  const formOf = (row: Item) => ({
    questionRu: row.question.ru,
    questionEn: row.question.en,
    answerRu: row.answer.ru,
    answerEn: row.answer.en,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
  });
  const valid =
    (form.questionRu.trim() !== '' || form.questionEn.trim() !== '') &&
    (form.answerRu.trim() !== '' || form.answerEn.trim() !== '');

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t('helpdesk.faq.hint')}</p>
      <AdminSection refresh={resource.refresh} state={resource.state}>
        {(data) => (
          <DataTable
            columns={[
              {
                key: 'question',
                header: t('helpdesk.faq.question'),
                cell: (row) => row.question.ru || row.question.en,
              },
              { key: 'order', header: t('helpdesk.faq.order'), cell: (row) => row.sortOrder },
              {
                key: 'enabled',
                header: t('helpdesk.faq.shown'),
                cell: (row) => (
                  <Badge variant={row.enabled ? 'success' : 'secondary'}>
                    {row.enabled ? t('helpdesk.faq.on') : t('helpdesk.faq.off')}
                  </Badge>
                ),
              },
              {
                key: 'actions',
                header: '',
                cell: (row) =>
                  canWrite ? (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setEditing(row.id);
                          setForm(formOf(row));
                        }}
                      >
                        {t('helpdesk.edit')}
                      </Button>
                      <Button
                        disabled={pending}
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          run(
                            'PUT',
                            `api/admin/v1/support/faq/${row.id}`,
                            bodyOf({ ...formOf(row), enabled: !row.enabled }),
                          );
                        }}
                      >
                        {row.enabled ? t('helpdesk.faq.hide') : t('helpdesk.faq.show')}
                      </Button>
                      <Button
                        disabled={pending}
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          run('DELETE', `api/admin/v1/support/faq/${row.id}`);
                        }}
                      >
                        {t('helpdesk.delete')}
                      </Button>
                    </div>
                  ) : null,
              },
            ]}
            labels={{ loadMore: t('more'), emptyTitle: t('helpdesk.faq.empty') }}
            rowKey={(row) => row.id}
            rows={data.items}
          />
        )}
      </AdminSection>
      {canWrite ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {editing ? t('helpdesk.faq.editTitle') : t('helpdesk.faq.createTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="faq-question-ru">{t('helpdesk.faq.questionRu')}</Label>
              <Input
                id="faq-question-ru"
                maxLength={128}
                value={form.questionRu}
                onChange={(event) => {
                  setForm({ ...form, questionRu: event.target.value });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="faq-question-en">{t('helpdesk.faq.questionEn')}</Label>
              <Input
                id="faq-question-en"
                maxLength={128}
                value={form.questionEn}
                onChange={(event) => {
                  setForm({ ...form, questionEn: event.target.value });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="faq-answer-ru">{t('helpdesk.faq.answerRu')}</Label>
              <textarea
                className={textarea}
                id="faq-answer-ru"
                value={form.answerRu}
                onChange={(event) => {
                  setForm({ ...form, answerRu: event.target.value });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="faq-answer-en">{t('helpdesk.faq.answerEn')}</Label>
              <textarea
                className={textarea}
                id="faq-answer-en"
                value={form.answerEn}
                onChange={(event) => {
                  setForm({ ...form, answerEn: event.target.value });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="faq-order">{t('helpdesk.faq.order')}</Label>
              <Input
                id="faq-order"
                min={0}
                type="number"
                value={form.sortOrder}
                onChange={(event) => {
                  setForm({ ...form, sortOrder: Number(event.target.value) });
                }}
              />
            </div>
            <div className="flex items-end gap-2 sm:col-span-2">
              <Button
                disabled={pending || !valid}
                onClick={() => {
                  if (editing) run('PUT', `api/admin/v1/support/faq/${editing}`, bodyOf(form));
                  else run('POST', 'api/admin/v1/support/faq', bodyOf(form));
                }}
              >
                {t('settings.save')}
              </Button>
              {editing ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditing(null);
                    setForm(EMPTY);
                  }}
                >
                  {t('cancel')}
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
