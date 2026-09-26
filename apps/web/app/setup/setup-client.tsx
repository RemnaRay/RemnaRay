'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { z } from 'zod';

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  useToast,
} from '@remnaray/ui';

import { browserApi } from '../../lib/api';
import {
  complete,
  initialValues,
  ProviderFields,
  providerFieldSchema,
  toConfig,
  type ProviderValues,
} from '../_components/provider-fields';
import { TimeZoneOptions } from '../_components/time-zones';

const squadSchema = z.object({ uuid: z.string(), name: z.string() });
const stateSchema = z.object({
  authenticated: z.boolean(),
  completed: z.boolean(),
  step: z.string(),
  draft: z.record(z.string(), z.unknown()).optional(),
  defaults: z
    .object({
      domain: z.string(),
      acmeEmail: z.string(),
      tlsMode: z.string(),
      proxyProfile: z.string(),
      themeUpload: z.boolean().optional(),
    })
    .optional(),
  themes: z.array(z.object({ slug: z.string(), name: z.string() })).optional(),
  providers: z
    .array(
      z.object({
        code: z.string(),
        kind: z.string(),
        fields: z.array(providerFieldSchema).default([]),
      }),
    )
    .optional(),
});
const tokenSchema = z.object({ accepted: z.boolean(), state: stateSchema });
const adminStepSchema = z.object({
  confirmed: z.boolean(),
  otpauthUrl: z.string().optional(),
  qrPng: z.string().optional(),
});
const panelCheckSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  version: z.string().nullable().optional(),
  squads: z.array(squadSchema).optional(),
  webhook: z.record(z.string(), z.string()).optional(),
});
const botCheckSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  username: z.string().optional(),
});
const savedSchema = z.object({ saved: z.boolean() }).loose();
const finishSchema = z.object({
  completed: z.boolean(),
  botLink: z.string().nullable(),
  adminUrl: z.string(),
});

type State = z.infer<typeof stateSchema>;
type Squad = z.infer<typeof squadSchema>;

const TOTAL_STEPS = 8;
const LOCALES = ['ru', 'en'] as const;

function field(draft: Record<string, unknown> | undefined, group: string, name: string): string {
  const section = draft?.[group];
  if (!section || typeof section !== 'object') return '';
  const value = (section as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** Section 17.4: the eight-step wizard, served on the neutral `_admin` theme. */
export default function SetupClient() {
  const t = useTranslations('setup');
  const errors = useTranslations('errors');
  const { toast } = useToast();
  const [state, setState] = useState<State | null>(null);
  const [step, setStep] = useState(1);
  const [pending, setPending] = useState(false);

  const fail = useCallback(
    (error: unknown) => {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code).toLowerCase()
          : 'internal_error';
      toast({
        title: t('errorTitle'),
        // `internal_error` is the only catalogued message that takes a
        // placeholder, and the wizard has no incident id to show.
        description:
          errors.has(code) && code !== 'internal_error'
            ? errors(code)
            : errors('internal_error', { incidentId: '—' }),
        variant: 'danger',
      });
    },
    [errors, t, toast],
  );

  const refresh = useCallback(async () => {
    const next = await browserApi().get('api/setup/v1/state', stateSchema);
    setState(next);
    if (next.authenticated) setStep(Math.min(TOTAL_STEPS, Math.max(1, Number(next.step) || 1)));
    return next;
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const run = useCallback(
    async <T,>(work: () => Promise<T>): Promise<T | null> => {
      setPending(true);
      try {
        return await work();
      } catch (error) {
        fail(error);
        return null;
      } finally {
        setPending(false);
      }
    },
    [fail],
  );

  if (!state) return <Shell title={t('title')} subtitle={t('subtitle')} />;

  if (!state.authenticated)
    return (
      <Shell title={t('title')} subtitle={t('subtitle')}>
        <TokenStep
          pending={pending}
          submit={(token) =>
            void run(async () => {
              const result = await browserApi().send('POST', 'api/setup/v1/token', tokenSchema, {
                token,
              });
              setState(result.state);
              setStep(Math.min(TOTAL_STEPS, Math.max(1, Number(result.state.step) || 1)));
              return result;
            })
          }
        />
      </Shell>
    );

  const common = { pending, run, refresh, setStep, state };
  return (
    <Shell title={t('title')} subtitle={t('step', { current: step, total: TOTAL_STEPS })}>
      <ol className="flex flex-wrap gap-2" aria-label={t('subtitle')}>
        {Array.from({ length: TOTAL_STEPS }, (_, index) => index + 1).map((index) => (
          <li key={index}>
            <Badge variant={index === step ? 'default' : index < step ? 'success' : 'outline'}>
              {index}
            </Badge>
          </li>
        ))}
      </ol>
      {step === 1 ? <AdminStep {...common} /> : null}
      {step === 2 ? <DomainStep {...common} /> : null}
      {step === 3 ? <PanelStep {...common} /> : null}
      {step === 4 ? <BotStep {...common} /> : null}
      {step === 5 ? <BrandStep {...common} /> : null}
      {step === 6 ? <PlanStep {...common} /> : null}
      {step === 7 ? <PaymentsStep {...common} /> : null}
      {step === 8 ? <DoneStep {...common} /> : null}
    </Shell>
  );
}

type StepProps = {
  pending: boolean;
  state: State;
  run: <T>(work: () => Promise<T>) => Promise<T | null>;
  refresh: () => Promise<State>;
  setStep: (step: number) => void;
};

function Shell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children?: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </header>
      {children}
    </main>
  );
}

function StepCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

function TextField({
  id,
  label,
  hint,
  type = 'text',
  list,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  type?: string;
  /** The id of a `<datalist>` of suggestions. */
  list?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        list={list}
        type={type}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Nav({ back, children }: { back?: (() => void) | undefined; children: React.ReactNode }) {
  const t = useTranslations('setup');
  return (
    <div className="flex flex-wrap gap-2">
      {back ? (
        <Button variant="secondary" onClick={back}>
          {t('back')}
        </Button>
      ) : null}
      {children}
    </div>
  );
}

function TokenStep({ pending, submit }: { pending: boolean; submit: (token: string) => void }) {
  const t = useTranslations('setup');
  const [token, setToken] = useState('');
  return (
    <StepCard title={t('token.title')} description={t('token.description')}>
      <TextField
        id="setup-token"
        label={t('token.field')}
        type="password"
        value={token}
        onChange={setToken}
      />
      <Nav>
        <Button
          disabled={pending || token.length === 0}
          onClick={() => {
            submit(token);
          }}
        >
          {t('token.submit')}
        </Button>
      </Nav>
    </StepCard>
  );
}

function AdminStep({ pending, state, run, refresh }: StepProps) {
  const t = useTranslations('setup');
  const [email, setEmail] = useState(field(state.draft, 'admin', 'email'));
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [enrolment, setEnrolment] = useState<{ otpauthUrl: string; qrPng: string } | null>(null);
  const mismatch = confirm.length > 0 && password !== confirm;

  const submit = (withCode: boolean) =>
    void run(async () => {
      const result = await browserApi().send('POST', 'api/setup/v1/steps/1', adminStepSchema, {
        email,
        password,
        passwordConfirm: confirm,
        ...(withCode ? { code } : {}),
      });
      if (result.confirmed) {
        await refresh();
        return result;
      }
      if (result.otpauthUrl && result.qrPng)
        setEnrolment({ otpauthUrl: result.otpauthUrl, qrPng: result.qrPng });
      return result;
    });

  return (
    <StepCard title={t('admin.title')} description={t('admin.description')}>
      <TextField
        id="setup-admin-email"
        label={t('admin.email')}
        type="email"
        value={email}
        onChange={setEmail}
      />
      <TextField
        id="setup-admin-password"
        label={t('admin.password')}
        hint={t('admin.passwordHint')}
        type="password"
        value={password}
        onChange={setPassword}
      />
      <TextField
        id="setup-admin-confirm"
        label={t('admin.passwordConfirm')}
        type="password"
        value={confirm}
        onChange={setConfirm}
      />
      {mismatch ? <p className="text-sm text-danger">{t('admin.passwordMismatch')}</p> : null}

      {enrolment ? (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">{t('admin.totpTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('admin.totpHint')}</p>
          <img
            alt={t('admin.totpAlt')}
            className="size-48 self-center rounded-md border border-border bg-white p-2"
            height={192}
            src={`data:image/png;base64,${enrolment.qrPng}`}
            width={192}
          />
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {t('admin.totpSecret')}
            </summary>
            <p className="mt-2 break-all font-mono text-xs">{enrolment.otpauthUrl}</p>
          </details>
          <TextField
            id="setup-admin-code"
            label={t('admin.totpCode')}
            value={code}
            onChange={(value) => {
              setCode(value.replaceAll(/\D/gu, ''));
            }}
          />
        </div>
      ) : null}

      <Nav>
        {enrolment ? (
          <Button
            disabled={pending || code.length !== 6}
            onClick={() => {
              submit(true);
            }}
          >
            {t('admin.confirm')}
          </Button>
        ) : (
          <Button
            disabled={pending || mismatch || password.length < 12 || email.length === 0}
            onClick={() => {
              submit(false);
            }}
          >
            {t('next')}
          </Button>
        )}
      </Nav>
    </StepCard>
  );
}

function DomainStep({ pending, state, run, refresh, setStep }: StepProps) {
  const t = useTranslations('setup');
  const [main, setMain] = useState(
    field(state.draft, 'domain', 'main') || (state.defaults?.domain ?? ''),
  );
  const [acmeEmail, setAcmeEmail] = useState(
    field(state.draft, 'domain', 'acmeEmail') || (state.defaults?.acmeEmail ?? ''),
  );

  return (
    <StepCard title={t('domain.title')} description={t('domain.description')}>
      <TextField id="setup-domain" label={t('domain.main')} value={main} onChange={setMain} />
      <TextField
        id="setup-acme"
        label={t('domain.acmeEmail')}
        type="email"
        value={acmeEmail}
        onChange={setAcmeEmail}
      />
      <p className="text-xs text-muted-foreground">
        {t('domain.tls', {
          mode: state.defaults?.tlsMode ?? 'acme',
          profile: state.defaults?.proxyProfile ?? 'nginx',
        })}
      </p>
      <p className="text-xs text-muted-foreground">{t('domain.dnsHint', { domain: main })}</p>
      <Nav
        back={() => {
          setStep(1);
        }}
      >
        <Button
          disabled={pending || main.length === 0}
          onClick={() =>
            void run(async () => {
              await browserApi().send('POST', 'api/setup/v1/steps/2', savedSchema, {
                main,
                acmeEmail,
              });
              return refresh();
            })
          }
        >
          {t('next')}
        </Button>
      </Nav>
    </StepCard>
  );
}

function PanelStep({ pending, state, run, refresh, setStep }: StepProps) {
  const t = useTranslations('setup');
  const [baseUrl, setBaseUrl] = useState(field(state.draft, 'panel', 'baseUrl'));
  const [apiToken, setApiToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [headers, setHeaders] = useState('{}');
  const [check, setCheck] = useState<z.infer<typeof panelCheckSchema> | null>(null);

  const extraHeaders = useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(headers || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : null;
    } catch {
      return null;
    }
  }, [headers]);

  return (
    <StepCard title={t('panel.title')} description={t('panel.description')}>
      <TextField
        hint={t('panel.baseUrlHint')}
        id="setup-panel-url"
        label={t('panel.baseUrl')}
        value={baseUrl}
        onChange={setBaseUrl}
      />
      <TextField
        id="setup-panel-token"
        label={t('panel.apiToken')}
        type="password"
        value={apiToken}
        onChange={setApiToken}
      />
      <TextField
        id="setup-panel-webhook-secret"
        label={t('panel.webhookSecret')}
        type="password"
        value={webhookSecret}
        onChange={setWebhookSecret}
      />
      <p className="text-xs text-muted-foreground">{t('panel.webhookSecretHint')}</p>
      <div className="flex flex-col gap-2">
        <Label htmlFor="setup-panel-headers">{t('panel.extraHeaders')}</Label>
        <textarea
          className="min-h-24 rounded-md border border-border bg-background p-3 font-mono text-sm"
          id="setup-panel-headers"
          value={headers}
          onChange={(event) => {
            setHeaders(event.target.value);
          }}
        />
        <p className="text-xs text-muted-foreground">{t('panel.extraHeadersHint')}</p>
      </div>

      {check ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
          <Badge variant={check.ok ? 'success' : 'danger'}>
            {check.ok ? t('checkOk') : t('checkFailed')}
          </Badge>
          {check.ok ? (
            <>
              <p>{t('panel.version', { version: check.version ?? '—' })}</p>
              <p>{t('panel.squads', { count: check.squads?.length ?? 0 })}</p>
              <p className="font-semibold">{t('panel.webhook')}</p>
              <pre className="overflow-x-auto rounded bg-muted/30 p-2 font-mono text-xs">
                {Object.entries(check.webhook ?? {})
                  .map(([key, value]) => `${key}=${value}`)
                  .join('\n')}
              </pre>
            </>
          ) : (
            <p className="text-danger">{check.error}</p>
          )}
        </div>
      ) : null}

      <Nav
        back={() => {
          setStep(2);
        }}
      >
        <Button
          disabled={pending || !extraHeaders || baseUrl.length === 0 || apiToken.length === 0}
          variant="secondary"
          onClick={() =>
            void run(async () => {
              const result = await browserApi().send(
                'POST',
                'api/setup/v1/check/panel',
                panelCheckSchema,
                {
                  baseUrl,
                  apiToken,
                  webhookSecret: webhookSecret || undefined,
                  extraHeaders: extraHeaders ?? {},
                },
              );
              setCheck(result);
              return result;
            })
          }
        >
          {pending ? t('checking') : t('check')}
        </Button>
        <Button
          disabled={pending || check?.ok !== true}
          onClick={() =>
            void run(async () => {
              await browserApi().send('POST', 'api/setup/v1/steps/3', savedSchema, {
                baseUrl,
                apiToken,
                webhookSecret: webhookSecret || undefined,
                extraHeaders: extraHeaders ?? {},
              });
              return refresh();
            })
          }
        >
          {t('next')}
        </Button>
      </Nav>
    </StepCard>
  );
}

function BotStep({ pending, state, run, refresh, setStep }: StepProps) {
  const t = useTranslations('setup');
  const [token, setToken] = useState('');
  const [mode, setMode] = useState(field(state.draft, 'bot', 'mode') || 'webhook');
  const [support, setSupport] = useState(field(state.draft, 'bot', 'supportContact'));
  const [check, setCheck] = useState<z.infer<typeof botCheckSchema> | null>(null);
  // Owner decision F35: an optional support bot and the operators' chat.
  const [supportBotToken, setSupportBotToken] = useState('');
  const [supportCheck, setSupportCheck] = useState<z.infer<typeof botCheckSchema> | null>(null);
  const [supportChatId, setSupportChatId] = useState(field(state.draft, 'bot', 'supportChatId'));
  const chatIdValid = supportChatId.trim() === '' || /^-?\d+$/u.test(supportChatId.trim());
  const domain = field(state.draft, 'domain', 'main') || (state.defaults?.domain ?? '');

  return (
    <StepCard title={t('bot.title')} description={t('bot.description')}>
      <TextField
        id="setup-bot-token"
        label={t('bot.token')}
        type="password"
        value={token}
        onChange={setToken}
      />
      <div className="flex flex-col gap-2">
        <Label htmlFor="setup-bot-mode">{t('bot.mode')}</Label>
        <select
          className="h-10 rounded-md border border-border bg-background px-3 text-sm"
          id="setup-bot-mode"
          value={mode}
          onChange={(event) => {
            setMode(event.target.value);
          }}
        >
          <option value="webhook">{t('bot.modeWebhook')}</option>
          <option value="polling">{t('bot.modePolling')}</option>
        </select>
      </div>
      <TextField
        id="setup-bot-support"
        label={t('bot.support')}
        hint={t('bot.supportHint')}
        value={support}
        onChange={setSupport}
      />
      <TextField
        id="setup-bot-support-chat"
        label={t('bot.supportChat')}
        hint={t('bot.supportChatHint')}
        value={supportChatId}
        onChange={setSupportChatId}
      />
      <TextField
        id="setup-bot-support-token"
        label={t('bot.supportBot')}
        hint={t('bot.supportBotHint')}
        type="password"
        value={supportBotToken}
        onChange={(value) => {
          setSupportBotToken(value);
          setSupportCheck(null);
        }}
      />
      {supportCheck ? (
        <p className={supportCheck.ok ? 'text-sm' : 'text-sm text-danger'}>
          {supportCheck.ok
            ? t('bot.supportBotUsername', { username: supportCheck.username ?? '' })
            : supportCheck.error}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t('bot.siteLogin', { domain })}</p>

      {check ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
          <Badge variant={check.ok ? 'success' : 'danger'}>
            {check.ok ? t('checkOk') : t('checkFailed')}
          </Badge>
          {check.ok ? (
            <p>{t('bot.username', { username: check.username ?? '' })}</p>
          ) : (
            <p className="text-danger">{check.error}</p>
          )}
        </div>
      ) : null}

      <Nav
        back={() => {
          setStep(3);
        }}
      >
        <Button
          disabled={pending || token.length === 0}
          variant="secondary"
          onClick={() =>
            void run(async () => {
              const result = await browserApi().send(
                'POST',
                'api/setup/v1/check/bot',
                botCheckSchema,
                { token },
              );
              setCheck(result);
              return result;
            })
          }
        >
          {pending ? t('checking') : t('check')}
        </Button>
        {supportBotToken ? (
          <Button
            disabled={pending}
            variant="secondary"
            onClick={() =>
              void run(async () => {
                const result = await browserApi().send(
                  'POST',
                  'api/setup/v1/check/bot',
                  botCheckSchema,
                  { token: supportBotToken },
                );
                setSupportCheck(result);
                return result;
              })
            }
          >
            {t('bot.supportBotCheck')}
          </Button>
        ) : null}
        <Button
          disabled={pending || check?.ok !== true || support.length === 0 || !chatIdValid}
          onClick={() =>
            void run(async () => {
              await browserApi().send('POST', 'api/setup/v1/steps/4', savedSchema, {
                token,
                mode,
                supportContact: support,
                supportBotToken,
                supportChatId: supportChatId.trim() === '' ? null : Number(supportChatId.trim()),
              });
              return refresh();
            })
          }
        >
          {t('next')}
        </Button>
      </Nav>
    </StepCard>
  );
}

function BrandStep({ pending, state, run, refresh, setStep }: StepProps) {
  const t = useTranslations('setup');
  const [name, setName] = useState(field(state.draft, 'brand', 'name') || 'RemnaRay Shop');
  const [sloganRu, setSloganRu] = useState('');
  const [sloganEn, setSloganEn] = useState('');
  const [defaultLocale, setDefaultLocale] = useState<'ru' | 'en'>('ru');
  const [enabled, setEnabled] = useState<string[]>([...LOCALES]);
  const [timezone, setTimezone] = useState('Europe/Moscow');
  const [themeSlug, setThemeSlug] = useState(state.themes?.[0]?.slug ?? 'manta');
  const [logo, setLogo] = useState<File | null>(null);
  const [logoAsset, setLogoAsset] = useState('');

  return (
    <StepCard title={t('brand.title')} description={t('brand.description')}>
      <TextField id="setup-brand-name" label={t('brand.name')} value={name} onChange={setName} />
      <TextField
        id="setup-brand-slogan-ru"
        label={t('brand.sloganRu')}
        value={sloganRu}
        onChange={setSloganRu}
      />
      <TextField
        id="setup-brand-slogan-en"
        label={t('brand.sloganEn')}
        value={sloganEn}
        onChange={setSloganEn}
      />
      <div className="flex flex-col gap-2">
        <Label htmlFor="setup-brand-locale">{t('brand.defaultLocale')}</Label>
        <select
          className="h-10 rounded-md border border-border bg-background px-3 text-sm"
          id="setup-brand-locale"
          value={defaultLocale}
          onChange={(event) => {
            setDefaultLocale(event.target.value === 'en' ? 'en' : 'ru');
          }}
        >
          {LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {locale}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t('brand.enabledLocales')}</legend>
        {LOCALES.map((locale) => (
          <label key={locale} className="flex items-center gap-2 text-sm">
            <input
              checked={enabled.includes(locale)}
              type="checkbox"
              onChange={(event) => {
                setEnabled((current) =>
                  event.target.checked
                    ? [...new Set([...current, locale])]
                    : current.filter((item) => item !== locale),
                );
              }}
            />
            {locale}
          </label>
        ))}
      </fieldset>
      <TextField
        hint={t('brand.timezoneHint')}
        id="setup-brand-timezone"
        label={t('brand.timezone')}
        list="setup-time-zones"
        value={timezone}
        onChange={setTimezone}
      />
      <TimeZoneOptions id="setup-time-zones" />
      <div className="flex flex-col gap-2">
        <Label htmlFor="setup-brand-theme">{t('brand.theme')}</Label>
        <select
          className="h-10 rounded-md border border-border bg-background px-3 text-sm"
          id="setup-brand-theme"
          value={themeSlug}
          onChange={(event) => {
            setThemeSlug(event.target.value);
          }}
        >
          {(state.themes ?? [{ slug: 'manta', name: 'Manta' }]).map((theme) => (
            <option key={theme.slug} value={theme.slug}>
              {theme.name}
            </option>
          ))}
        </select>
      </div>
      {state.defaults?.themeUpload ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="setup-brand-logo">{t('brand.logo')}</Label>
          <input
            accept="image/png,image/svg+xml"
            className="text-sm"
            id="setup-brand-logo"
            type="file"
            onChange={(event) => {
              setLogo(event.target.files?.[0] ?? null);
              setLogoAsset('');
            }}
          />
          {logoAsset ? <span className="text-xs text-muted-foreground">{logoAsset}</span> : null}
        </div>
      ) : null}
      <Nav
        back={() => {
          setStep(4);
        }}
      >
        <Button
          disabled={pending || name.length === 0 || !enabled.includes(defaultLocale)}
          onClick={() =>
            void run(async () => {
              let uploadedLogo = logoAsset;
              if (logo) {
                const form = new FormData();
                form.append('theme', themeSlug);
                form.append('file', logo);
                const upload = await fetch('/api/setup/v1/theme-logo', {
                  method: 'POST',
                  headers: { 'x-requested-with': 'RemnaRay' },
                  body: form,
                });
                if (!upload.ok) throw new Error('Logo upload failed');
                uploadedLogo = ((await upload.json()) as { asset: string }).asset;
                setLogoAsset(uploadedLogo);
              }
              await browserApi().send('POST', 'api/setup/v1/steps/5', savedSchema, {
                name,
                slogan: { ru: sloganRu, en: sloganEn },
                defaultLocale,
                enabledLocales: enabled,
                timezone,
                themeSlug,
                ...(uploadedLogo ? { logo: uploadedLogo } : {}),
              });
              return refresh();
            })
          }
        >
          {t('next')}
        </Button>
      </Nav>
    </StepCard>
  );
}

function PlanStep({ pending, state, run, refresh, setStep }: StepProps) {
  const t = useTranslations('setup');
  const squads = useMemo<Squad[]>(() => {
    const panel = state.draft?.['panel'];
    const list = panel && typeof panel === 'object' ? (panel as { squads?: unknown }).squads : null;
    return Array.isArray(list) ? (list as Squad[]) : [];
  }, [state.draft]);

  const [slug, setSlug] = useState('month');
  const [nameRu, setNameRu] = useState('Месяц');
  const [nameEn, setNameEn] = useState('Month');
  const [duration, setDuration] = useState('30');
  const [devices, setDevices] = useState('3');
  const [price, setPrice] = useState('299');
  // Section 8: a plan names at least one squad; all loaded squads are
  // selected until the owner changes the choice.
  const [chosen, setChosen] = useState<string[] | null>(null);
  const selected = chosen ?? squads.map((squad) => squad.uuid);
  const [trialEnabled, setTrialEnabled] = useState(true);
  const [trialDays, setTrialDays] = useState('3');
  const [trialTraffic, setTrialTraffic] = useState('10');
  const [trialDevices, setTrialDevices] = useState('1');

  return (
    <StepCard title={t('plan.title')} description={t('plan.description')}>
      <TextField id="setup-plan-slug" label={t('plan.slug')} value={slug} onChange={setSlug} />
      <TextField
        id="setup-plan-name-ru"
        label={t('plan.nameRu')}
        value={nameRu}
        onChange={setNameRu}
      />
      <TextField
        id="setup-plan-name-en"
        label={t('plan.nameEn')}
        value={nameEn}
        onChange={setNameEn}
      />
      <TextField
        id="setup-plan-duration"
        label={t('plan.duration')}
        value={duration}
        onChange={setDuration}
      />
      <TextField
        id="setup-plan-devices"
        label={t('plan.devices')}
        value={devices}
        onChange={setDevices}
      />
      <TextField id="setup-plan-price" label={t('plan.price')} value={price} onChange={setPrice} />
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t('plan.squads')}</legend>
        {squads.map((squad) => (
          <label key={squad.uuid} className="flex items-center gap-2 text-sm">
            <input
              checked={selected.includes(squad.uuid)}
              type="checkbox"
              onChange={(event) => {
                setChosen(
                  event.target.checked
                    ? [...new Set([...selected, squad.uuid])]
                    : selected.filter((item) => item !== squad.uuid),
                );
              }}
            />
            {squad.name}
          </label>
        ))}
        <p className="text-xs text-muted-foreground">
          {squads.length === 0 ? t('plan.squadsMissing') : t('plan.squadsHint')}
        </p>
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input
          checked={trialEnabled}
          type="checkbox"
          onChange={(event) => {
            setTrialEnabled(event.target.checked);
          }}
        />
        {t('plan.trialEnabled')}
      </label>
      <TextField
        id="setup-trial-days"
        label={t('plan.trialDays')}
        value={trialDays}
        onChange={setTrialDays}
      />
      <TextField
        id="setup-trial-traffic"
        label={t('plan.trialTraffic')}
        value={trialTraffic}
        onChange={setTrialTraffic}
      />
      <TextField
        id="setup-trial-devices"
        label={t('plan.trialDevices')}
        value={trialDevices}
        onChange={setTrialDevices}
      />

      <Nav
        back={() => {
          setStep(5);
        }}
      >
        <Button
          disabled={pending || slug.length === 0 || selected.length === 0}
          onClick={() =>
            void run(async () => {
              await browserApi().send('POST', 'api/setup/v1/steps/6', savedSchema, {
                plan: {
                  slug,
                  name: { ru: nameRu, en: nameEn },
                  durationDays: Number(duration),
                  deviceLimit: Number(devices),
                  squads: selected,
                  priceMinor: String(Math.round(Number(price) * 100)),
                },
                trial: {
                  enabled: trialEnabled,
                  days: Number(trialDays),
                  traffic_gb: Number(trialTraffic),
                  device_limit: Number(trialDevices),
                  squads: selected,
                },
              });
              return refresh();
            })
          }
        >
          {t('next')}
        </Button>
      </Nav>
    </StepCard>
  );
}

function PaymentsStep({ pending, state, run, refresh, setStep }: StepProps) {
  const t = useTranslations('setup');
  const [status, setStatus] = useState<'none' | 'self_employed' | 'company'>('none');
  const [selected, setSelected] = useState<string[]>([]);
  const [configs, setConfigs] = useState<Record<string, ProviderValues>>({});
  const [checks, setChecks] = useState<Record<string, { ok: boolean; error?: string | undefined }>>(
    {},
  );

  const providers = state.providers ?? [];
  const fiscal = {
    mode: status === 'self_employed' ? ('provider_receipt' as const) : ('none' as const),
    self_employed: status === 'self_employed',
    vat_code: 1,
    sno: status === 'self_employed' ? 'npd' : 'usn_income',
    fallback_email: '',
  };

  const fieldsOf = (code: string) =>
    providers.find((provider) => provider.code === code)?.fields ?? [];
  const valuesOf = (code: string) => configs[code] ?? initialValues(fieldsOf(code));
  const parsed = (code: string): Record<string, unknown> | null =>
    complete(fieldsOf(code), valuesOf(code)) ? toConfig(fieldsOf(code), valuesOf(code)) : null;
  const label = (key: string) =>
    t.has(`payments.field.${key}`) ? t(`payments.field.${key}`) : key;
  const hint = (key: string) =>
    t.has(`payments.hint.${key}`) ? t(`payments.hint.${key}`) : undefined;

  const save = (skipped: boolean) =>
    void run(async () => {
      await browserApi().send('POST', 'api/setup/v1/steps/7', savedSchema, {
        skipped,
        providers: skipped
          ? []
          : selected.map((code) => ({
              code,
              enabled: true,
              config: toConfig(fieldsOf(code), valuesOf(code)),
            })),
        fiscal,
      });
      return refresh();
    });

  return (
    <StepCard title={t('payments.title')} description={t('payments.description')}>
      <div className="flex flex-col gap-2">
        <Label htmlFor="setup-fiscal-status">{t('payments.status')}</Label>
        <select
          className="h-10 rounded-md border border-border bg-background px-3 text-sm"
          id="setup-fiscal-status"
          value={status}
          onChange={(event) => {
            const value = event.target.value;
            setStatus(value === 'self_employed' || value === 'company' ? value : 'none');
          }}
        >
          <option value="none">{t('payments.statusNone')}</option>
          <option value="self_employed">{t('payments.statusSelfEmployed')}</option>
          <option value="company">{t('payments.statusCompany')}</option>
        </select>
        <p className="text-xs text-muted-foreground">{t('payments.statusHint')}</p>
      </div>

      <ul className="flex flex-col gap-4">
        {providers.map((provider) => (
          <li
            key={provider.code}
            className="flex flex-col gap-2 rounded-md border border-border p-3"
          >
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input
                checked={selected.includes(provider.code)}
                type="checkbox"
                onChange={(event) => {
                  setSelected((current) =>
                    event.target.checked
                      ? [...new Set([...current, provider.code])]
                      : current.filter((item) => item !== provider.code),
                  );
                }}
              />
              {t.has(`payments.providerName.${provider.code}`)
                ? t(`payments.providerName.${provider.code}`)
                : provider.code}
            </label>
            {selected.includes(provider.code) ? (
              <>
                <ProviderFields
                  fields={provider.fields}
                  hint={hint}
                  idPrefix={`setup-provider-${provider.code}`}
                  label={label}
                  values={valuesOf(provider.code)}
                  onChange={(values) => {
                    setConfigs((current) => ({ ...current, [provider.code]: values }));
                  }}
                />
                <div className="flex items-center gap-2">
                  <Button
                    disabled={pending || !parsed(provider.code)}
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void run(async () => {
                        const result = await browserApi().send(
                          'POST',
                          'api/setup/v1/check/provider',
                          z.object({ ok: z.boolean(), error: z.string().optional() }),
                          { code: provider.code, config: parsed(provider.code) ?? {} },
                        );
                        setChecks((current) => ({ ...current, [provider.code]: result }));
                        return result;
                      })
                    }
                  >
                    {pending ? t('checking') : t('check')}
                  </Button>
                  {checks[provider.code] ? (
                    <Badge variant={checks[provider.code]?.ok ? 'success' : 'danger'}>
                      {checks[provider.code]?.ok ? t('checkOk') : t('checkFailed')}
                    </Badge>
                  ) : null}
                </div>
              </>
            ) : null}
          </li>
        ))}
      </ul>

      <Nav
        back={() => {
          setStep(6);
        }}
      >
        <Button
          disabled={pending}
          variant="secondary"
          onClick={() => {
            save(true);
          }}
        >
          {t('skip')}
        </Button>
        <Button
          disabled={
            pending || selected.length === 0 || selected.some((code) => parsed(code) === null)
          }
          onClick={() => {
            save(false);
          }}
        >
          {t('next')}
        </Button>
      </Nav>
    </StepCard>
  );
}

function DoneStep({ pending, state, run, setStep }: StepProps) {
  const t = useTranslations('setup');
  const [result, setResult] = useState<z.infer<typeof finishSchema> | null>(null);
  const draft = state.draft ?? {};
  const rows: [string, string][] = [
    [t('summary.admin'), field(draft, 'admin', 'email')],
    [t('summary.domain'), field(draft, 'domain', 'main')],
    [t('summary.panel'), field(draft, 'panel', 'baseUrl')],
    [t('summary.bot'), field(draft, 'bot', 'username')],
    [t('summary.brand'), field(draft, 'brand', 'name')],
    [t('summary.plan'), field(draft, 'plan', 'slug')],
  ];

  if (result)
    return (
      <StepCard title={t('done.launched')} description={t('done.removeToken')}>
        <div className="flex flex-wrap gap-2">
          {result.botLink ? (
            <Button asChild>
              <a href={result.botLink} rel="noreferrer">
                {t('done.bot')}
              </a>
            </Button>
          ) : null}
          <Button asChild variant="secondary">
            <a href="/admin">{t('done.admin')}</a>
          </Button>
        </div>
      </StepCard>
    );

  return (
    <StepCard title={t('done.title')} description={t('done.description')}>
      <dl className="flex flex-col gap-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 border-b border-border pb-1">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium">{value || t('summary.none')}</dd>
          </div>
        ))}
      </dl>
      <Nav
        back={() => {
          setStep(7);
        }}
      >
        <Button
          disabled={pending}
          onClick={() =>
            void run(async () => {
              const finished = await browserApi().send(
                'POST',
                'api/setup/v1/finish',
                finishSchema,
                {},
              );
              setResult(finished);
              return finished;
            })
          }
        >
          {t('done.launch')}
        </Button>
      </Nav>
    </StepCard>
  );
}
