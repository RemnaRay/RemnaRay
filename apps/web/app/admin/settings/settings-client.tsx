'use client';

import { useCallback, useState } from 'react';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@remnaray/ui';

import { adminApi, errorCode } from '../../../lib/admin-client';
import { invalidate, useResource } from '../../../lib/resource';
import { AdminShell } from '../admin-shell';
import { AdminSection, useAdminErrorMessage } from '../admin-states';
import { SupportTab } from './support-tab';
import { ProvidersTab, providersSchema } from './providers-tab';
import { TimeZoneOptions } from '../../_components/time-zones';

const schemaSchema = z.object({
  version: z.literal(1),
  type: z.literal('object'),
  properties: z.record(
    z.string(),
    z.object({
      title: z.string(),
      description: z.string(),
      default: z.unknown(),
      'x-secret': z.boolean(),
    }),
  ),
});
const flatSchema = z.record(z.string(), z.unknown());
const themesSchema = z.object({
  items: z.array(z.object({ slug: z.string(), name: z.string(), builtin: z.boolean() })),
  active: z.string(),
});
const entriesSchema = z.object({
  items: z.array(
    z.object({ key: z.string(), default: z.string().nullable(), override: z.string().nullable() }),
  ),
});
const legalSchema = z.object({
  doc: z.string(),
  lang: z.string(),
  markdown: z.string(),
  overridden: z.boolean(),
});
const appliedSchema = z.object({
  applied: z.array(z.string()),
  restartRequired: z.array(z.string()),
  reconfigured: z.array(z.string()),
});

type Data = {
  schema: z.infer<typeof schemaSchema>;
  values: Record<string, unknown>;
  providers: z.infer<typeof providersSchema>;
  themes: z.infer<typeof themesSchema>;
};

const NAMESPACES = ['landing', 'account', 'bot', 'notify', 'errors', 'seo', 'common'];
const LEGAL_DOCS = ['terms', 'privacy', 'offer'];
const EDITABLE_GROUPS = [
  'brand',
  'domain',
  'locale',
  'trial',
  'subscription',
  'invoice',
  'balance',
  'fiscal',
  'notifications',
  // Section 9.8 recipients, a JSON array; secret, so it is written whole.
  'webhooks',
  'operator',
  'admin',
];

export default function SettingsAdminClient() {
  const t = useTranslations('admin');
  const { toast } = useToast();
  const message = useAdminErrorMessage();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [lang, setLang] = useState('ru');
  const [namespace, setNamespace] = useState('landing');
  const [doc, setDoc] = useState('terms');
  const [legalDraft, setLegalDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const resource = useResource<Data>('admin:settings', async () => {
    const api = adminApi();
    const [schema, values, providers, themes] = await Promise.all([
      api.get('api/admin/v1/settings/schema', schemaSchema),
      api.get('api/admin/v1/settings', flatSchema),
      api.get('api/admin/v1/providers', providersSchema),
      api.get('api/admin/v1/themes', themesSchema),
    ]);
    return { schema, values, providers, themes };
  });

  const locales = useResource(`admin:i18n:${lang}:${namespace}`, () =>
    adminApi().get(`api/admin/v1/i18n/${lang}/${namespace}`, entriesSchema),
  );
  const legal = useResource(`admin:legal:${doc}:${lang}`, () =>
    adminApi().get(`api/admin/v1/i18n/legal/${doc}/${lang}`, legalSchema),
  );

  const fail = useCallback(
    (error: unknown) => {
      toast({
        title: t('errorTitle'),
        description: message(errorCode(error)),
        variant: 'danger',
      });
    },
    [message, t, toast],
  );

  const save = useCallback(() => {
    if (Object.keys(draft).length === 0) return;
    setPending(true);
    adminApi()
      .send('PUT', 'api/admin/v1/settings', appliedSchema, { patch: parseDraft(draft) })
      .then((result) => {
        setDraft({});
        invalidate('admin:settings');
        toast({
          title: t('settings.applied', { count: result.applied.length }),
          ...(result.reconfigured.length > 0
            ? {
                description: t('settings.reconfigured', {
                  channels: result.reconfigured.join(', '),
                }),
              }
            : {}),
        });
      }, fail)
      .finally(() => {
        setPending(false);
      });
  }, [draft, fail, t, toast]);

  return (
    <AdminShell>
      {() => (
        <section className="flex flex-col gap-6">
          <h1 className="text-2xl font-bold">{t('settings.title')}</h1>

          <Tabs defaultValue="store">
            <TabsList>
              <TabsTrigger value="store">{t('settings.tab.store')}</TabsTrigger>
              <TabsTrigger value="providers">{t('settings.tab.providers')}</TabsTrigger>
              <TabsTrigger value="support">{t('settings.tab.support')}</TabsTrigger>
              <TabsTrigger value="theme">{t('settings.tab.theme')}</TabsTrigger>
              <TabsTrigger value="locales">{t('settings.tab.locales')}</TabsTrigger>
              <TabsTrigger value="legal">{t('settings.tab.legal')}</TabsTrigger>
            </TabsList>

            <TabsContent value="store">
              <AdminSection refresh={resource.refresh} state={resource.state}>
                {(data) => (
                  <div className="flex flex-col gap-4">
                    <div className="grid gap-3 lg:grid-cols-2">
                      {Object.entries(data.schema.properties)
                        .filter(([key]) => EDITABLE_GROUPS.includes(key.split('.')[0] ?? ''))
                        .map(([key, property]) => (
                          <div className="flex flex-col gap-1" key={key}>
                            <Label htmlFor={key}>{key}</Label>
                            <Input
                              id={key}
                              {...(key === 'locale.timezone' ? { list: 'admin-time-zones' } : {})}
                              placeholder={property.description}
                              value={
                                draft[key] ??
                                (property['x-secret'] ? '' : stringify(data.values[key]))
                              }
                              onChange={(event) => {
                                setDraft({ ...draft, [key]: event.target.value });
                              }}
                            />
                            {key === 'locale.timezone' ? (
                              <TimeZoneOptions id="admin-time-zones" />
                            ) : null}
                            {property['x-secret'] ? (
                              <span className="text-xs text-muted-foreground">
                                {isSet(data.values[key])
                                  ? t('settings.secretSet')
                                  : t('settings.secretUnset')}
                              </span>
                            ) : null}
                          </div>
                        ))}
                    </div>
                    <div className="flex gap-2">
                      <Button disabled={pending || Object.keys(draft).length === 0} onClick={save}>
                        {t('settings.save')}
                      </Button>
                      <Button asChild variant="secondary">
                        <a download href="/api/admin/v1/settings/export">
                          {t('settings.export')}
                        </a>
                      </Button>
                    </div>
                  </div>
                )}
              </AdminSection>
            </TabsContent>

            <TabsContent value="providers">
              <AdminSection refresh={resource.refresh} state={resource.state}>
                {(data) => (
                  <ProvidersTab
                    fail={fail}
                    notify={(title) => {
                      toast({ title });
                    }}
                    pending={pending}
                    providers={data.providers.items}
                    setPending={setPending}
                  />
                )}
              </AdminSection>
            </TabsContent>

            <TabsContent value="support">
              <SupportTab
                fail={fail}
                notify={(title) => {
                  toast({ title });
                }}
              />
            </TabsContent>

            <TabsContent value="theme">
              <AdminSection refresh={resource.refresh} state={resource.state}>
                {(data) => (
                  <Card>
                    <CardHeader>
                      <CardTitle>{t('theme.title')}</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-wrap items-end gap-3">
                      <div className="flex w-64 flex-col gap-1">
                        <Label htmlFor="theme-slug">{t('theme.active')}</Label>
                        <Select
                          value={draft['theme.slug'] ?? data.themes.active}
                          onValueChange={(value) => {
                            setDraft({ ...draft, 'theme.slug': value });
                          }}
                        >
                          <SelectTrigger id="theme-slug">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {data.themes.items
                              .filter((theme) => !theme.builtin)
                              .map((theme) => (
                                <SelectItem key={theme.slug} value={theme.slug}>
                                  {theme.name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Button
                        disabled={pending || !draft['theme.slug']}
                        onClick={() => {
                          setPending(true);
                          adminApi()
                            .send('PUT', 'api/admin/v1/themes/active', z.unknown(), {
                              slug: draft['theme.slug'],
                              reason: 'theme change',
                            })
                            .then(() => {
                              setDraft({});
                              invalidate('admin:settings');
                              toast({ title: t('saved') });
                            }, fail)
                            .finally(() => {
                              setPending(false);
                            });
                        }}
                      >
                        {t('theme.apply')}
                      </Button>
                    </CardContent>
                  </Card>
                )}
              </AdminSection>
            </TabsContent>

            <TabsContent value="locales">
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-3">
                  <div className="flex w-32 flex-col gap-1">
                    <Label htmlFor="locale-lang">{t('locales.language')}</Label>
                    <Select value={lang} onValueChange={setLang}>
                      <SelectTrigger id="locale-lang">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ru">ru</SelectItem>
                        <SelectItem value="en">en</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex w-48 flex-col gap-1">
                    <Label htmlFor="locale-ns">{t('locales.namespace')}</Label>
                    <Select value={namespace} onValueChange={setNamespace}>
                      <SelectTrigger id="locale-ns">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {NAMESPACES.map((item) => (
                          <SelectItem key={item} value={item}>
                            {item}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <AdminSection refresh={locales.refresh} state={locales.state}>
                  {(data) => (
                    <DataTable
                      columns={[
                        { key: 'key', header: t('settings.key'), cell: (row) => row.key },
                        {
                          key: 'default',
                          header: t('locales.default'),
                          cell: (row) => (
                            <span className="text-xs text-muted-foreground">{row.default}</span>
                          ),
                        },
                        {
                          key: 'override',
                          header: t('locales.override'),
                          cell: (row) => (
                            <Input
                              defaultValue={row.override ?? ''}
                              onBlur={(event) => {
                                const value = event.target.value;
                                if (value === (row.override ?? '')) return;
                                void adminApi()
                                  .send(
                                    'PUT',
                                    `api/admin/v1/i18n/${lang}/${namespace}`,
                                    z.unknown(),
                                    {
                                      patch: { [row.key]: value === '' ? null : value },
                                      reason: 'locale override',
                                    },
                                  )
                                  .then(() => {
                                    invalidate(`admin:i18n:${lang}:${namespace}`);
                                    toast({ title: t('saved') });
                                  }, fail);
                              }}
                            />
                          ),
                        },
                      ]}
                      labels={{
                        loadMore: t('more'),
                        emptyTitle: t('empty'),
                        errorTitle: t('errorTitle'),
                      }}
                      rowKey={(row) => row.key}
                      rows={data.items}
                    />
                  )}
                </AdminSection>
              </div>
            </TabsContent>

            <TabsContent value="legal">
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-3">
                  <div className="flex w-48 flex-col gap-1">
                    <Label htmlFor="legal-doc">{t('legal.document')}</Label>
                    <Select value={doc} onValueChange={setDoc}>
                      <SelectTrigger id="legal-doc">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LEGAL_DOCS.map((item) => (
                          <SelectItem key={item} value={item}>
                            {item}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <AdminSection refresh={legal.refresh} state={legal.state}>
                  {(data) => (
                    <div className="flex flex-col gap-3">
                      <Label htmlFor="legal-markdown">{t('legal.markdown')}</Label>
                      <textarea
                        className="min-h-96 rounded-md border border-border bg-background p-3 font-mono text-sm"
                        id="legal-markdown"
                        value={legalDraft ?? data.markdown}
                        onChange={(event) => {
                          setLegalDraft(event.target.value);
                        }}
                      />
                      <div>
                        <Button
                          disabled={pending || legalDraft === null}
                          onClick={() => {
                            setPending(true);
                            adminApi()
                              .send('PUT', `api/admin/v1/i18n/legal/${doc}/${lang}`, z.unknown(), {
                                markdown: legalDraft ?? data.markdown,
                                reason: 'legal text update',
                              })
                              .then(() => {
                                setLegalDraft(null);
                                invalidate(`admin:legal:${doc}:${lang}`);
                                toast({ title: t('saved') });
                              }, fail)
                              .finally(() => {
                                setPending(false);
                              });
                          }}
                        >
                          {t('settings.save')}
                        </Button>
                      </div>
                    </div>
                  )}
                </AdminSection>
              </div>
            </TabsContent>
          </Tabs>
        </section>
      )}
    </AdminShell>
  );
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function isSet(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'set' in value
    ? Boolean(value.set)
    : Boolean(value);
}

/** Text inputs carry JSON for non-string settings, so parse before sending. */
function parseDraft(draft: Record<string, string>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(draft)) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (/^(?:true|false|null|-?\d+(?:\.\d+)?|\[.*\]|\{.*\})$/su.test(trimmed)) {
      try {
        patch[key] = JSON.parse(trimmed);
        continue;
      } catch {
        // fall through to the raw string
      }
    }
    patch[key] = raw;
  }
  return patch;
}
