'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { z } from 'zod';

import {
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
export const templatesSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      title: z.string(),
      body: localized,
      sortOrder: z.number(),
    }),
  ),
});
type Template = z.infer<typeof templatesSchema>['items'][number];

const EMPTY = { code: '', title: '', ru: '', en: '', sortOrder: 100 };
const textarea = 'min-h-24 rounded-md border border-border bg-background p-3 text-sm';

/** Answer templates for `/t <code>` in the operators' chat. */
export function TemplatesTab({
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
  const resource = useResource('admin:support:templates', () =>
    adminApi().get('api/admin/v1/support/templates', templatesSchema),
  );
  const run = (method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) => {
    setPending(true);
    adminApi()
      .send(method, path, z.unknown(), body)
      .then(() => {
        setEditing(null);
        setForm(EMPTY);
        invalidate('admin:support:templates');
        notify(t('saved'));
      }, fail)
      .finally(() => {
        setPending(false);
      });
  };
  const edit = (row: Template) => {
    setEditing(row.id);
    setForm({ code: row.code, title: row.title, ...row.body, sortOrder: row.sortOrder });
  };
  const valid =
    /^[a-z0-9_-]{1,32}$/u.test(form.code) &&
    form.title.trim() !== '' &&
    (form.ru.trim() !== '' || form.en.trim() !== '');

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t('helpdesk.templates.hint')}</p>
      <AdminSection refresh={resource.refresh} state={resource.state}>
        {(data) => (
          <DataTable
            columns={[
              {
                key: 'code',
                header: t('helpdesk.templates.code'),
                cell: (row) => `/t ${row.code}`,
              },
              { key: 'title', header: t('helpdesk.templates.name'), cell: (row) => row.title },
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
                          edit(row);
                        }}
                      >
                        {t('helpdesk.edit')}
                      </Button>
                      <Button
                        disabled={pending}
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          run('DELETE', `api/admin/v1/support/templates/${row.id}`);
                        }}
                      >
                        {t('helpdesk.delete')}
                      </Button>
                    </div>
                  ) : null,
              },
            ]}
            labels={{ loadMore: t('more'), emptyTitle: t('helpdesk.templates.empty') }}
            rowKey={(row) => row.id}
            rows={data.items}
          />
        )}
      </AdminSection>
      {canWrite ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {editing ? t('helpdesk.templates.editTitle') : t('helpdesk.templates.createTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="template-code">{t('helpdesk.templates.code')}</Label>
              <Input
                id="template-code"
                placeholder="link"
                value={form.code}
                onChange={(event) => {
                  setForm({ ...form, code: event.target.value.toLowerCase() });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="template-title">{t('helpdesk.templates.name')}</Label>
              <Input
                id="template-title"
                value={form.title}
                onChange={(event) => {
                  setForm({ ...form, title: event.target.value });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="template-ru">{t('helpdesk.textRu')}</Label>
              <textarea
                className={textarea}
                id="template-ru"
                value={form.ru}
                onChange={(event) => {
                  setForm({ ...form, ru: event.target.value });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="template-en">{t('helpdesk.textEn')}</Label>
              <textarea
                className={textarea}
                id="template-en"
                value={form.en}
                onChange={(event) => {
                  setForm({ ...form, en: event.target.value });
                }}
              />
            </div>
            <div className="flex gap-2 sm:col-span-2">
              <Button
                disabled={pending || !valid}
                onClick={() => {
                  const body = {
                    code: form.code,
                    title: form.title,
                    body: { ru: form.ru, en: form.en },
                    sortOrder: form.sortOrder,
                  };
                  if (editing) run('PUT', `api/admin/v1/support/templates/${editing}`, body);
                  else run('POST', 'api/admin/v1/support/templates', body);
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
